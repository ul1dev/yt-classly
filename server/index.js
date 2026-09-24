import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openDb, classRows, createBooking } from './db.js';
import fs from 'node:fs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const app = express();
const db = openDb();
const production = process.env.NODE_ENV === 'production';
const passwordHash = process.env.OWNER_PASSWORD_HASH;
if (!passwordHash || !/^\$2[aby]\$/.test(passwordHash)) throw new Error('Set OWNER_PASSWORD_HASH to a bcrypt hash');
app.set('trust proxy', production ? 1 : false);
app.use(express.json({ limit: '32kb' }));

const cookieName = 'studio_session';
const sessionHash = value => crypto.createHash('sha256').update(value).digest('hex');
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
const authenticated = req => {
  const token = cookie(req)[cookieName];
  if (!token) return false;
  return Boolean(db.prepare('SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?').get(sessionHash(token),Date.now()));
};
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
app.use('/api', originGuard);
app.post('/api/login', (req,res) => {
  const ip = req.ip;
  const current = loginLimit(ip);
  if (current.count >= 8) return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.' });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!bcrypt.compareSync(password,passwordHash)) {
    attempts.set(ip,{ count: current.count + 1, until: current.until });
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id_hash,expires_at) VALUES (?,?)').run(sessionHash(token),Date.now()+7*86400000);
  setCookie(res,token,7*86400);
  res.json({ ok:true });
});
app.get('/api/session', (req,res) => res.json({ authenticated: authenticated(req) }));
app.post('/api/logout', (req,res) => {
  const token = cookie(req)[cookieName];
  if (token) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(sessionHash(token));
  setCookie(res,'',0);
  res.json({ ok:true });
});
app.use('/api', (req,res,next) => authenticated(req) ? next() : res.status(401).json({ error: 'Требуется вход' }));

const classSchema = z.object({
  title:z.string().trim().min(1).max(120),
  date:z.iso.date(),
  time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  duration:z.coerce.number().int().min(5).max(480),
  teacher:z.string().trim().min(1).max(120),
  capacity:z.coerce.number().int().min(1).max(1000)
});
const clientSchema = z.object({
  name:z.string().trim().min(1).max(120),
  email:z.email().max(254),
  phone:z.string().trim().min(5).max(40)
});
const id = raw => Number.isSafeInteger(Number(raw)) && Number(raw)>0 ? Number(raw) : null;
const validate = (schema,body,res) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) { res.status(400).json({ error:'Проверьте заполненные поля' }); return null; }
  return parsed.data;
};

app.get('/api/classes',(req,res) => res.json(classRows(db)));
app.post('/api/classes',(req,res) => {
  const data=validate(classSchema,req.body,res); if (!data) return;
  const result=db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity) VALUES (@title,@date,@time,@duration,@teacher,@capacity)').run(data);
  res.status(201).json({ id:result.lastInsertRowid });
});
app.put('/api/classes/:id',(req,res) => {
  const classId=id(req.params.id), data=validate(classSchema,req.body,res); if (!data) return;
  const result=db.transaction(()=>{
    const lesson=db.prepare('SELECT id FROM classes WHERE id=?').get(classId);
    if (!lesson) return {status:404,error:'Занятие не найдено'};
    const count=db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE class_id=?').get(classId).count;
    if (data.capacity<count) return {status:409,error:`Уже записано ${count} клиентов. Мест не может быть меньше.`};
    db.prepare('UPDATE classes SET title=@title,date=@date,time=@time,duration=@duration,teacher=@teacher,capacity=@capacity WHERE id=@id').run({...data,id:classId});
    return null;
  }).immediate();
  if (result) return res.status(result.status).json({error:result.error});
  res.json({ ok:true });
});
app.get('/api/clients',(req,res) => res.json(db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE,id').all()));
app.post('/api/clients',(req,res) => {
  const data=validate(clientSchema,req.body,res); if (!data) return;
  const result=db.prepare('INSERT INTO clients (name,email,phone) VALUES (@name,@email,@phone)').run(data);
  res.status(201).json({ id:result.lastInsertRowid });
});
app.put('/api/clients/:id',(req,res) => {
  const clientId=id(req.params.id),data=validate(clientSchema,req.body,res); if (!data) return;
  const result=db.prepare('UPDATE clients SET name=@name,email=@email,phone=@phone WHERE id=@id').run({...data,id:clientId});
  if (!result.changes) return res.status(404).json({ error:'Клиент не найден' });
  res.json({ ok:true });
});
app.get('/api/bookings',(req,res) => res.json(db.prepare(`SELECT b.id,b.class_id,b.client_id,b.created_at,c.name AS client_name,c.email,c.phone,l.title,l.date,l.time,l.teacher FROM bookings b JOIN clients c ON c.id=b.client_id JOIN classes l ON l.id=b.class_id ORDER BY l.date,l.time,c.name`).all()));
app.post('/api/bookings',(req,res) => {
  const classId=id(req.body?.class_id),clientId=id(req.body?.client_id);
  if (!classId || !clientId) return res.status(400).json({ error:'Выберите занятие и клиента' });
  const result=createBooking(db,classId,clientId);
  if (result.error) return res.status(result.status).json({ error:result.error });
  res.status(201).json(result);
});
app.delete('/api/bookings/:id',(req,res) => {
  const result=db.prepare('DELETE FROM bookings WHERE id=?').run(id(req.params.id));
  if (!result.changes) return res.status(404).json({ error:'Запись не найдена' });
  res.json({ ok:true });
});
app.use('/api',(req,res) => res.status(404).json({ error:'Не найдено' }));
const root=path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root,'../dist')));
app.get('/{*path}',(req,res) => res.sendFile(path.join(root,'../dist/index.html')));
app.listen(Number(process.env.PORT)||3001,() => console.log('Studio server listening'));
