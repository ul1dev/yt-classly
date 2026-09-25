import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openDb, classRows, createSeries, updateClass, createBooking, createMembership, cancelBooking, cancelClass, bookingCancellationPreview } from './db.js';
import fs from 'node:fs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const app = express();
const db = openDb();
const production = process.env.NODE_ENV === 'production';
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const bootstrapHash = process.env.OWNER_PASSWORD_HASH;
if (adminEmail) {
  if (!z.email().safeParse(adminEmail).success) throw new Error('ADMIN_EMAIL must be a valid email');
  const existing = db.prepare('SELECT id,role,branch_id FROM accounts WHERE email=?').get(adminEmail);
  if (!existing) {
    if (!bootstrapHash || !/^\$2[aby]\$/.test(bootstrapHash)) throw new Error('Set OWNER_PASSWORD_HASH to bootstrap the administrator');
    db.prepare("INSERT INTO accounts (email,password_hash,role) VALUES (?,?,'admin')").run(adminEmail,bootstrapHash);
  } else if (existing.role !== 'admin' || existing.branch_id !== null) {
    throw new Error('ADMIN_EMAIL must belong to the owner account');
  }
}
app.set('trust proxy', production ? 1 : false);
app.use(express.json({ limit: '32kb' }));

const cookieName = 'studio_session';
const sessionHash = value => crypto.createHash('sha256').update(value).digest('hex');
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
const currentUser = req => {
  const token = cookie(req)[cookieName];
  if (!token) return null;
  return db.prepare(`SELECT a.id,a.email,a.role,a.client_id,a.branch_id,c.name FROM sessions s JOIN accounts a ON a.id=s.user_id LEFT JOIN clients c ON c.id=a.client_id WHERE s.id_hash=? AND s.expires_at>?`).get(sessionHash(token),Date.now()) || null;
};
const sessionPayload = user => user ? {authenticated:true,role:user.role,email:user.email,clientId:user.client_id,branchId:user.branch_id,isOwner:user.role==='admin'&&user.branch_id===null,name:user.name} : {authenticated:false};
const setCookie = (res, value, maxAge) => {
  const parts = [`${cookieName}=${encodeURIComponent(value)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`];
  if (production) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
};
const attempts = new Map();
const loginLimit = (ip) => {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, until: now + 15 * 60000 };
  if (entry.until < now) return { count: 0, until: now + 15 * 60000 };
  return entry;
};
const originGuard = (req,res,next) => {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const host = new URL(origin).host;
    if (host === req.get('host')) return next();
  } catch {}
  res.status(403).json({ error: 'Недопустимый источник запроса' });
};
app.use('/api', (req,res,next) => {res.setHeader('Cache-Control','no-store');next()}, originGuard);
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const passwordSchema = z.string().min(8).max(128).refine(value => Buffer.byteLength(value,'utf8')<=72);
const registrationSchema = z.object({
  name:z.string().trim().min(1).max(120),
  email:emailSchema,
  phone:z.string().trim().min(5).max(40),
  password:passwordSchema
});
const startSession = (res,userId) => {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id_hash,expires_at,user_id) VALUES (?,?,?)').run(sessionHash(token),Date.now()+7*86400000,userId);
  setCookie(res,token,7*86400);
};
const dummyHash = bcrypt.hashSync('unknown-account-password',12);
app.post('/api/register',(req,res) => {
  const ip = req.ip;
  const current = loginLimit('register:'+ip);
  if (current.count >= 8) return res.status(429).json({error:'Слишком много попыток. Повторите позже.'});
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:'Проверьте имя, email, телефон и пароль (не менее 8 символов)'});
  const data = parsed.data;
  attempts.set('register:'+ip,{count:current.count+1,until:current.until});
  const hash = bcrypt.hashSync(data.password,12);
  const result = db.transaction(() => {
    if (db.prepare('SELECT id FROM accounts WHERE email=?').get(data.email)) return {error:'Аккаунт с этим email уже существует',status:409};
    let client = db.prepare('SELECT id FROM clients WHERE email=? COLLATE NOCASE').get(data.email);
    if (!client) {
      const created = db.prepare('INSERT INTO clients (name,email,phone) VALUES (?,?,?)').run(data.name,data.email,data.phone);
      client = {id:created.lastInsertRowid};
    }
    const account = db.prepare("INSERT INTO accounts (email,password_hash,role,client_id) VALUES (?,?,'client',?)").run(data.email,hash,client.id);
    return {id:account.lastInsertRowid};
  }).immediate();
  if (result.error) return res.status(result.status).json({error:result.error});
  startSession(res,result.id);
  res.status(201).json(sessionPayload(db.prepare(`SELECT a.id,a.email,a.role,a.client_id,a.branch_id,c.name FROM accounts a JOIN clients c ON c.id=a.client_id WHERE a.id=?`).get(result.id)));
});
app.post('/api/login', (req,res) => {
  const ip = req.ip;
  const current = loginLimit(ip);
  if (current.count >= 8) return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.' });
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT id,password_hash FROM accounts WHERE email=?').get(email);
  if (!bcrypt.compareSync(password,user?.password_hash || dummyHash)) {
    attempts.set(ip,{ count: current.count + 1, until: current.until });
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  attempts.delete(ip);
  startSession(res,user.id);
  res.json(sessionPayload(db.prepare(`SELECT a.id,a.email,a.role,a.client_id,a.branch_id,c.name FROM accounts a LEFT JOIN clients c ON c.id=a.client_id WHERE a.id=?`).get(user.id)));
});
app.get('/api/session', (req,res) => res.json(sessionPayload(currentUser(req))));
app.post('/api/logout', (req,res) => {
  const token = cookie(req)[cookieName];
  if (token) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(sessionHash(token));
  setCookie(res,'',0);
  res.json({ ok:true });
});
app.use('/api', (req,res,next) => {
  req.user = currentUser(req);
  return req.user ? next() : res.status(401).json({ error: 'Требуется вход' });
});
const adminOnly = (req,res,next) => req.user.role === 'admin' ? next() : res.status(403).json({error:'Доступно только администратору'});
const ownerOnly = (req,res,next) => req.user.role === 'admin' && req.user.branch_id === null ? next() : res.status(403).json({error:'Доступно только владельцу'});
const canManageBranch = (user,branchId) => user.role==='admin' && (user.branch_id===null || user.branch_id===branchId);
const branchExists = branchId => !!db.prepare('SELECT id FROM branches WHERE id=?').get(branchId);

const classSchema = z.object({
  title:z.string().trim().min(1).max(120),
  date:z.iso.date(),
  time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  duration:z.coerce.number().int().min(5).max(480),
  teacher:z.string().trim().min(1).max(120),
  capacity:z.coerce.number().int().min(1).max(1000)
});
const seriesSchema = classSchema.omit({date:true}).extend({
  starts_on:z.iso.date(),
  ends_on:z.iso.date(),
  weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(days=>new Set(days).size===days.length)
});
const clientSchema = z.object({
  name:z.string().trim().min(1).max(120),
  email:emailSchema,
  phone:z.string().trim().min(5).max(40)
});
const membershipSchema = z.object({
  client_id:z.coerce.number().int().positive(),
  total_visits:z.union([z.literal(4),z.literal(8)]),
  starts_on:z.iso.date(),
  ends_on:z.iso.date(),
  branch_id:z.number().int().positive().nullable().optional()
}).refine(value=>value.starts_on<=value.ends_on);
const branchAdminSchema=z.object({email:emailSchema,password:passwordSchema,branch_id:z.number().int().positive()});
const id = raw => Number.isSafeInteger(Number(raw)) && Number(raw)>0 ? Number(raw) : null;
const validate = (schema,body,res) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) { res.status(400).json({ error:'Проверьте заполненные поля' }); return null; }
  return parsed.data;
};
const branchForClass = classId => db.prepare('SELECT branch_id FROM classes WHERE id=?').get(classId)?.branch_id;
const branchForBooking = bookingId => db.prepare('SELECT l.branch_id FROM bookings b JOIN classes l ON l.id=b.class_id WHERE b.id=?').get(bookingId)?.branch_id;
const requestedBranch = (req,res) => {
  const raw=req.query.branch_id;
  const branchId=raw===undefined?null:id(raw);
  if (raw!==undefined && !branchId) {res.status(400).json({error:'Выберите филиал'});return undefined}
  if (branchId && !branchExists(branchId)) {res.status(404).json({error:'Филиал не найден'});return undefined}
  if (req.user.role==='admin' && req.user.branch_id!==null) {
    if (branchId && branchId!==req.user.branch_id) {res.status(403).json({error:'Нет доступа к филиалу'});return undefined}
    return req.user.branch_id;
  }
  return branchId;
};

app.get('/api/branches',(req,res) => res.json(req.user.role==='admin' && req.user.branch_id!==null
  ? db.prepare('SELECT * FROM branches WHERE id=? ORDER BY id').all(req.user.branch_id)
  : db.prepare('SELECT * FROM branches ORDER BY id').all()));
app.get('/api/branch-admins',ownerOnly,(req,res) => res.json(db.prepare("SELECT a.id,a.email,a.branch_id,b.name AS branch_name FROM accounts a JOIN branches b ON b.id=a.branch_id WHERE a.role='admin' ORDER BY b.id,a.email").all()));
app.post('/api/branch-admins',ownerOnly,(req,res) => {
  const data=validate(branchAdminSchema,req.body,res); if (!data) return;
  if (!branchExists(data.branch_id)) return res.status(404).json({error:'Филиал не найден'});
  if (db.prepare('SELECT id FROM accounts WHERE email=?').get(data.email)) return res.status(409).json({error:'Аккаунт с этим email уже существует'});
  const hash=bcrypt.hashSync(data.password,12);
  const result=db.prepare("INSERT INTO accounts (email,password_hash,role,branch_id) VALUES (?,?,'admin',?)").run(data.email,hash,data.branch_id);
  res.status(201).json({id:result.lastInsertRowid});
});
app.get('/api/classes',(req,res) => {
  const branchId=requestedBranch(req,res);if (branchId===undefined) return;
  res.json(classRows(db,branchId));
});
app.post('/api/classes',adminOnly,(req,res) => {
  const data=validate(classSchema,req.body,res); if (!data) return;
  const branchId=req.body?.branch_id===undefined?(req.user.branch_id??1):id(req.body.branch_id);
  if (!branchId || !branchExists(branchId)) return res.status(400).json({error:'Выберите филиал'});
  if (!canManageBranch(req.user,branchId)) return res.status(403).json({error:'Нет доступа к филиалу'});
  const result=db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity,branch_id) VALUES (@title,@date,@time,@duration,@teacher,@capacity,@branch_id)').run({...data,branch_id:branchId});
  res.status(201).json({ id:result.lastInsertRowid });
});
app.post('/api/series',adminOnly,(req,res) => {
  const data=validate(seriesSchema,req.body,res); if (!data) return;
  const branchId=req.body?.branch_id===undefined?(req.user.branch_id??1):id(req.body.branch_id);
  if (!branchId || !branchExists(branchId)) return res.status(400).json({error:'Выберите филиал'});
  if (!canManageBranch(req.user,branchId)) return res.status(403).json({error:'Нет доступа к филиалу'});
  const result=createSeries(db,{...data,branch_id:branchId});
  if (result.error) return res.status(result.status).json({error:result.error});
  res.status(201).json(result);
});
app.put('/api/classes/:id',adminOnly,(req,res) => {
  const classId=id(req.params.id), data=validate(classSchema,req.body,res); if (!data) return;
  const branchId=branchForClass(classId);
  if (!branchId) return res.status(404).json({error:'Занятие не найдено'});
  if (!canManageBranch(req.user,branchId)) return res.status(403).json({error:'Нет доступа к филиалу'});
  const scope=req.body?.scope || 'single';
  if (!['single','future'].includes(scope)) return res.status(400).json({error:'Неверный режим редактирования'});
  const result=updateClass(db,classId,data,scope);
  if (result.error) return res.status(result.status).json({error:result.error});
  res.json(result);
});
app.post('/api/classes/:id/cancel',adminOnly,(req,res) => {
  const classId=id(req.params.id),branchId=branchForClass(classId);
  if (!branchId) return res.status(404).json({error:'Занятие не найдено'});
  if (!canManageBranch(req.user,branchId)) return res.status(403).json({error:'Нет доступа к филиалу'});
  const result=cancelClass(db,classId);
  if (result.error) return res.status(result.status).json({error:result.error});
  res.json(result);
});
app.get('/api/clients',adminOnly,(req,res) => res.json(db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE,id').all()));
app.post('/api/clients',ownerOnly,(req,res) => {
  const data=validate(clientSchema,req.body,res); if (!data) return;
  if (db.prepare('SELECT id FROM clients WHERE email=?').get(data.email)) return res.status(409).json({error:'Клиент с этим email уже существует'});
  const result=db.prepare('INSERT INTO clients (name,email,phone) VALUES (@name,@email,@phone)').run(data);
  res.status(201).json({ id:result.lastInsertRowid });
});
app.put('/api/clients/:id',ownerOnly,(req,res) => {
  const clientId=id(req.params.id),data=validate(clientSchema,req.body,res); if (!data) return;
  const result=db.transaction(()=>{
    if (!db.prepare('SELECT id FROM clients WHERE id=?').get(clientId)) return {status:404,error:'Клиент не найден'};
    if (db.prepare('SELECT id FROM clients WHERE email=? AND id<>?').get(data.email,clientId)) return {status:409,error:'Клиент с этим email уже существует'};
    const linked = db.prepare('SELECT id,email FROM accounts WHERE client_id=?').get(clientId);
    if (linked && linked.email !== data.email && db.prepare('SELECT id FROM accounts WHERE email=?').get(data.email)) return {status:409,error:'Этот email уже используется другим аккаунтом'};
    db.prepare('UPDATE clients SET name=@name,email=@email,phone=@phone WHERE id=@id').run({...data,id:clientId});
    if (linked) db.prepare('UPDATE accounts SET email=? WHERE id=?').run(data.email,linked.id);
    return null;
  }).immediate();
  if (result) return res.status(result.status).json({error:result.error});
  res.json({ ok:true });
});
app.get('/api/bookings',(req,res) => {
  if (req.user.role === 'client') {
    return res.json(db.prepare(`SELECT b.id,b.class_id,b.membership_id,l.title,l.date,l.time,l.teacher,l.branch_id,br.name AS branch_name FROM bookings b JOIN classes l ON l.id=b.class_id JOIN branches br ON br.id=l.branch_id WHERE b.client_id=? ORDER BY l.date,l.time`).all(req.user.client_id));
  }
  const query=`SELECT b.id,b.class_id,b.client_id,b.membership_id,b.created_at,c.name AS client_name,c.email,c.phone,l.title,l.date,l.time,l.teacher,l.branch_id,br.name AS branch_name FROM bookings b JOIN clients c ON c.id=b.client_id JOIN classes l ON l.id=b.class_id JOIN branches br ON br.id=l.branch_id`;
  res.json(req.user.branch_id===null
    ? db.prepare(`${query} ORDER BY l.date,l.time,c.name`).all()
    : db.prepare(`${query} WHERE l.branch_id=? ORDER BY l.date,l.time,c.name`).all(req.user.branch_id));
});
app.get('/api/memberships',(req,res) => {
  const query=`SELECT m.*,c.name AS client_name,c.email AS client_email,COALESCE(br.name,'Оба филиала') AS branch_name FROM memberships m JOIN clients c ON c.id=m.client_id LEFT JOIN branches br ON br.id=m.branch_id`;
  const rows=req.user.role==='client'
    ? db.prepare(`${query} WHERE m.client_id=? ORDER BY m.starts_on DESC,m.id DESC`).all(req.user.client_id)
    : req.user.branch_id===null
      ? db.prepare(`${query} ORDER BY m.starts_on DESC,m.id DESC`).all()
      : db.prepare(`${query} WHERE m.branch_id=? OR m.branch_id IS NULL ORDER BY m.starts_on DESC,m.id DESC`).all(req.user.branch_id);
  res.json(rows);
});
app.post('/api/memberships',adminOnly,(req,res) => {
  const data=validate(membershipSchema,req.body,res); if (!data) return;
  const branchId=data.branch_id===undefined?(req.user.branch_id??1):data.branch_id;
  if (branchId!==null && !branchExists(branchId)) return res.status(404).json({error:'Филиал не найден'});
  if (req.user.branch_id!==null && branchId!==req.user.branch_id) return res.status(403).json({error:'Нет доступа к абонементу другого филиала'});
  const result=createMembership(db,data.client_id,data.total_visits,data.starts_on,data.ends_on,branchId);
  if (result.error) return res.status(result.status).json({error:result.error});
  res.status(201).json(result);
});
app.get('/api/membership-events',adminOnly,(req,res) => {
  const query=`SELECT e.*,m.total_visits,m.starts_on,m.ends_on,c.name AS client_name,l.title AS class_title,l.date AS class_date,l.branch_id,br.name AS branch_name FROM membership_events e JOIN memberships m ON m.id=e.membership_id JOIN clients c ON c.id=e.client_id JOIN classes l ON l.id=e.class_id JOIN branches br ON br.id=l.branch_id`;
  res.json(req.user.branch_id===null?db.prepare(`${query} ORDER BY e.id DESC`).all():db.prepare(`${query} WHERE l.branch_id=? ORDER BY e.id DESC`).all(req.user.branch_id));
});
app.post('/api/bookings',(req,res) => {
  const classId=id(req.body?.class_id),clientId=req.user.role==='admin' ? id(req.body?.client_id) : req.user.client_id;
  if (!classId || !clientId) return res.status(400).json({ error:'Выберите занятие и клиента' });
  const branchId=branchForClass(classId);
  if (!branchId) return res.status(404).json({error:'Занятие не найдено'});
  if (req.user.role==='admin' && !canManageBranch(req.user,branchId)) return res.status(403).json({error:'Нет доступа к филиалу'});
  const rawMembership=req.body?.membership_id;
  const membershipId=rawMembership===undefined || rawMembership===null?null:id(rawMembership);
  if (rawMembership!==undefined && rawMembership!==null && !membershipId) return res.status(400).json({error:'Выберите абонемент'});
  const result=createBooking(db,classId,clientId,membershipId);
  if (result.error) return res.status(result.status).json({ error:result.error });
  res.status(201).json(result);
});
app.get('/api/bookings/:id/cancellation-preview',(req,res) => {
  if (req.user.role==='admin') {
    const branchId=branchForBooking(id(req.params.id));
    if (!branchId) return res.status(404).json({error:'Запись не найдена'});
    if (!canManageBranch(req.user,branchId)) return res.status(403).json({error:'Нет доступа к филиалу'});
  }
  const result=bookingCancellationPreview(db,id(req.params.id),req.user.role==='admin'?null:req.user.client_id);
  if (result.error) return res.status(result.status).json({error:result.error});
  res.json(result);
});
app.delete('/api/bookings/:id',(req,res) => {
  if (req.user.role==='admin') {
    const branchId=branchForBooking(id(req.params.id));
    if (!branchId) return res.status(404).json({error:'Запись не найдена'});
    if (!canManageBranch(req.user,branchId)) return res.status(403).json({error:'Нет доступа к филиалу'});
  }
  const result=cancelBooking(db,id(req.params.id),req.user.role==='admin'?null:req.user.client_id);
  if (result.error) return res.status(result.status).json({error:result.error});
  res.json(result);
});
app.use('/api',(req,res) => res.status(404).json({ error:'Не найдено' }));
const root=path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root,'../dist')));
app.get('/{*path}',(req,res) => res.sendFile(path.join(root,'../dist/index.html')));
app.listen(Number(process.env.PORT)||3001,() => console.log('Studio server listening'));
