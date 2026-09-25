import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, classRows, createSeries, updateClass, createBooking, createMembership, cancelBooking, cancelClass, bookingCancellationPreview } from './db.js';

test('seed persists, duplicate booking is blocked, cancellation frees the last place', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-'));
  const file=path.join(dir,'studio.db');
  const db=openDb(file);
  try {
    assert.equal(classRows(db).length,28);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM clients').get().count,8);
    const id=db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity) VALUES (?,?,?,?,?,?)').run('Тест','2026-10-01','10:00',60,'Тест',1).lastInsertRowid;
    assert.equal(createBooking(db,id,1).status,409);
    const membership=createMembership(db,1,4,'2026-10-01','2026-10-31');
    assert.ok(membership.id);
    const overlapping=createMembership(db,1,8,'2026-10-15','2026-11-15');
    assert.ok(overlapping.id);
    assert.ok(createMembership(db,2,4,'2026-10-01','2026-10-31').id);
    const booking=createBooking(db,id,1);
    assert.ok(booking.id);
    assert.equal(db.prepare('SELECT remaining_visits FROM memberships WHERE id=?').get(membership.id).remaining_visits,3);
    assert.equal(createBooking(db,id,1).status,409);
    assert.equal(createBooking(db,id,2).status,409);
    assert.deepEqual(cancelBooking(db,booking.id,null,Date.parse('2026-09-30T00:00:00+03:00')),{ok:true,refunded:true});
    assert.equal(db.prepare('SELECT remaining_visits FROM memberships WHERE id=?').get(membership.id).remaining_visits,4);
    assert.deepEqual(db.prepare('SELECT delta FROM membership_events WHERE membership_id=? ORDER BY id').all(membership.id).map(x=>x.delta),[-1,1]);
    assert.ok(createBooking(db,id,2).id);
    db.close();
    const reopened=openDb(file);
    assert.equal(classRows(reopened).length,29);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM bookings WHERE class_id=?').get(id).count,1);
    reopened.close();
  } finally { if(db.open) db.close();fs.rmSync(dir,{recursive:true,force:true}) }
});

test('migration merges duplicate emails without losing bookings or original card details',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-migration-'));
  const file=path.join(dir,'studio.db');
  const legacy=new Database(file);
  legacy.exec(`
    CREATE TABLE clients (id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE classes (id INTEGER PRIMARY KEY,title TEXT NOT NULL,date TEXT NOT NULL,time TEXT NOT NULL,duration INTEGER NOT NULL,teacher TEXT NOT NULL,capacity INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY,class_id INTEGER NOT NULL,client_id INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(class_id,client_id));
    CREATE TABLE sessions (id_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    INSERT INTO clients (id,name,email,phone) VALUES (1,'Первый','PERSON@EXAMPLE.COM','111'),(2,'Второй','person@example.com','222');
    INSERT INTO classes (id,title,date,time,duration,teacher,capacity) VALUES (1,'Первое','2026-10-01','10:00',60,'Иван',3),(2,'Второе','2026-10-01','12:00',60,'Иван',3);
    INSERT INTO bookings (id,class_id,client_id) VALUES (1,1,1),(2,2,2),(3,1,2);
  `);
  legacy.close();
  const db=openDb(file);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM clients').get().count,1);
    assert.equal(db.prepare('SELECT email FROM clients WHERE id=1').get().email,'person@example.com');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bookings').get().count,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE membership_id IS NOT NULL').get().count,0);
    assert.deepEqual(cancelBooking(db,1),{ok:true,refunded:false});
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM membership_events').get().count,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM client_merge_archive').get().count,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM booking_merge_archive').get().count,1);
    assert.throws(()=>db.prepare('INSERT INTO clients (name,email,phone) VALUES (?,?,?)').run('Третий','PERSON@example.com','333'));
  } finally {db.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('visit balance, date bounds and legacy cancellation',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-visits-'));
  const db=openDb(path.join(dir,'studio.db'));
  try {
    const clientId=1;
    const first=db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity) VALUES (?,?,?,?,?,?)').run('До срока','2026-09-30','10:00',60,'Тест',2).lastInsertRowid;
    const dates=['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05'];
    const ids=dates.map(date=>db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity) VALUES (?,?,?,?,?,?)').run('Тест',date,'10:00',60,'Тест',2).lastInsertRowid);
    const membership=createMembership(db,clientId,4,'2026-10-01','2026-10-05');
    assert.equal(createBooking(db,first,clientId).status,409);
    const bookings=ids.slice(0,4).map(id=>createBooking(db,id,clientId));
    assert.ok(bookings.every(result=>result.id));
    assert.equal(db.prepare('SELECT remaining_visits FROM memberships WHERE id=?').get(membership.id).remaining_visits,0);
    assert.equal(createBooking(db,ids[4],clientId).status,409);
    assert.deepEqual(cancelBooking(db,bookings[0].id,null,Date.parse('2026-09-30T00:00:00+03:00')),{ok:true,refunded:true});
    assert.equal(createBooking(db,ids[4],clientId).status,undefined);
    const legacy=db.prepare('SELECT id FROM bookings WHERE membership_id IS NULL LIMIT 1').get();
    const before=db.prepare('SELECT remaining_visits FROM memberships WHERE id=?').get(membership.id).remaining_visits;
    assert.deepEqual(cancelBooking(db,legacy.id),{ok:true,refunded:false});
    assert.equal(db.prepare('SELECT remaining_visits FROM memberships WHERE id=?').get(membership.id).remaining_visits,before);
  } finally {db.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('six-hour boundary and whole-class cancellation are atomic and idempotent',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-cancellation-'));
  const db=openDb(path.join(dir,'studio.db'));
  try {
    const date='2026-10-01',time='12:00';
    const start=Date.parse(`${date}T${time}:00+03:00`);
    const classId=db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity) VALUES (?,?,?,?,?,?)').run('Тест',date,time,60,'Тест',8).lastInsertRowid;
    const membership=createMembership(db,1,4,date,date);
    const first=createBooking(db,classId,1);
    assert.equal(bookingCancellationPreview(db,first.id,1,start-6*3600000).willRefund,true);
    assert.deepEqual(cancelBooking(db,first.id,1,start-6*3600000),{ok:true,refunded:true});
    const late=createBooking(db,classId,1);
    assert.equal(bookingCancellationPreview(db,late.id,1,start-6*3600000+1).willRefund,false);
    assert.deepEqual(cancelBooking(db,late.id,1,start-6*3600000+1),{ok:true,refunded:false});
    assert.equal(db.prepare('SELECT remaining_visits FROM memberships WHERE id=?').get(membership.id).remaining_visits,3);
    const another=createBooking(db,classId,1);
    db.prepare('INSERT INTO bookings (class_id,client_id) VALUES (?,?)').run(classId,2);
    const result=cancelClass(db,classId);
    assert.deepEqual(result,{ok:true,alreadyCancelled:false,cancelledBookings:2,refunded:2});
    assert.equal(db.prepare('SELECT remaining_visits FROM memberships WHERE id=?').get(membership.id).remaining_visits,4);
    assert.equal(db.prepare('SELECT status FROM classes WHERE id=?').get(classId).status,'cancelled');
    assert.equal(createBooking(db,classId,1).status,409);
    assert.deepEqual(cancelClass(db,classId),{ok:true,alreadyCancelled:true,cancelledBookings:0,refunded:0});
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM membership_events WHERE booking_id=? AND delta=1').get(another.id).count,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM membership_events WHERE booking_id=? AND delta=1').get(late.id).count,1);
  } finally {db.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('recurring series keeps independent bookings, exceptions and cancellations',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-series-'));
  const file=path.join(dir,'studio.db');
  const db=openDb(file);
  try {
    const base={title:'Вечерняя йога',time:'19:00',duration:60,teacher:'Анна',capacity:6};
    const created=createSeries(db,{...base,starts_on:'2026-10-05',ends_on:'2026-11-01',weekdays:[2,4]});
    assert.equal(created.count,8);
    const rows=db.prepare('SELECT * FROM classes WHERE series_id=? ORDER BY occurrence_date').all(created.id);
    assert.deepEqual(rows.map(row=>row.date),['2026-10-06','2026-10-08','2026-10-13','2026-10-15','2026-10-20','2026-10-22','2026-10-27','2026-10-29']);
    assert.equal(rows.every(row=>row.is_exception===0),true);
    createMembership(db,1,4,'2026-10-01','2026-11-01');
    createMembership(db,2,4,'2026-10-01','2026-11-01');
    assert.ok(createBooking(db,rows[0].id,1).id);
    assert.ok(createBooking(db,rows[1].id,2).id);
    assert.ok(createBooking(db,rows[1].id,1).id);
    assert.equal(classRows(db).find(row=>row.id===rows[0].id).booked,1);
    assert.equal(classRows(db).find(row=>row.id===rows[1].id).booked,2);
    assert.equal(classRows(db).find(row=>row.id===rows[2].id).booked,0);
    assert.equal(updateClass(db,rows[2].id,{...base,title:'Особая йога',date:'2026-10-14'},'single').updated,1);
    assert.equal(updateClass(db,rows[1].id,{...base,date:'2026-10-08',time:'20:00',capacity:1},'future').status,409);
    assert.equal(db.prepare('SELECT time FROM classes WHERE id=?').get(rows[4].id).time,'19:00');
    assert.equal(updateClass(db,rows[1].id,{...base,date:'2026-10-08',time:'20:00',teacher:'Мария',capacity:7},'future').updated,6);
    const after=db.prepare('SELECT * FROM classes WHERE series_id=? ORDER BY occurrence_date').all(created.id);
    assert.equal(after[0].time,'19:00');
    assert.equal(after[1].time,'20:00');
    assert.equal(after[2].title,'Особая йога');
    assert.equal(after[2].date,'2026-10-14');
    assert.equal(after[2].is_exception,1);
    assert.equal(after[3].time,'20:00');
    assert.equal(updateClass(db,rows[1].id,{...base,date:'2026-10-09',time:'20:00',teacher:'Мария',capacity:7},'future').updated,6);
    assert.equal(db.prepare('SELECT date FROM classes WHERE id=?').get(rows[1].id).date,'2026-10-09');
    assert.equal(db.prepare('SELECT date FROM classes WHERE id=?').get(rows[2].id).date,'2026-10-14');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM classes WHERE series_id=?').get(created.id).count,8);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM membership_events').get().count,3);
    assert.equal(cancelClass(db,rows[3].id).cancelledBookings,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classes WHERE series_id=? AND status='active'").get(created.id).count,7);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE class_id IN (?,?)').get(rows[0].id,rows[1].id).count,3);
    db.close();
    const reopened=openDb(file);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM classes WHERE series_id=?').get(created.id).count,8);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM bookings WHERE class_id IN (?,?)').get(rows[0].id,rows[1].id).count,3);
    reopened.close();
  } finally {if(db.open)db.close();fs.rmSync(dir,{recursive:true,force:true})}
});
