import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, classRows, createBooking } from './db.js';

test('seed persists, duplicate booking is blocked, cancellation frees the last place', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-'));
  const file=path.join(dir,'studio.db');
  const db=openDb(file);
  try {
    assert.equal(classRows(db).length,28);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM clients').get().count,8);
    const id=db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity) VALUES (?,?,?,?,?,?)').run('Тест','2026-10-01','10:00',60,'Тест',1).lastInsertRowid;
    assert.ok(createBooking(db,id,1).id);
    assert.equal(createBooking(db,id,1).status,409);
    assert.equal(createBooking(db,id,2).status,409);
    db.prepare('DELETE FROM bookings WHERE class_id=? AND client_id=1').run(id);
    assert.ok(createBooking(db,id,2).id);
    db.close();
    const reopened=openDb(file);
    assert.equal(classRows(reopened).length,29);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM bookings WHERE class_id=?').get(id).count,1);
    reopened.close();
  } finally { if(db.open) db.close();fs.rmSync(dir,{recursive:true,force:true}) }
});
