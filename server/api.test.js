import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

async function freePort() {
  return new Promise((resolve,reject)=>{
    const server=createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))});
    server.on('error',reject);
  });
}
async function start(port,file) {
  const child=spawn(process.execPath,['server/index.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DB_PATH:file,OWNER_PASSWORD_HASH:bcrypt.hashSync('test-password',4),NODE_ENV:'test'},stdio:'ignore'});
  for(let i=0;i<80;i++){
    if(child.exitCode!==null) throw new Error('Server exited');
    try {await fetch(`http://127.0.0.1:${port}/api/session`);return child} catch {await new Promise(r=>setTimeout(r,50))}
  }
  child.kill();throw new Error('Server did not start');
}
async function stop(child){child.kill();await new Promise(r=>child.once('exit',r))}

test('API authentication, CRUD, capacity, duplicate, cancellation and restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-api-'));
  const file=path.join(dir,'studio.db');
  const port=await freePort();
  let child=await start(port,file);
  let cookie='';
  const call=async(route,method='GET',body)=>{
    const response=await fetch(`http://127.0.0.1:${port}/api${route}`,{method,headers:{'Content-Type':'application/json',cookie},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  try{
    assert.equal((await call('/classes')).status,401);
    assert.equal((await call('/login','POST',{password:'wrong'})).status,401);
    const login=await call('/login','POST',{password:'test-password'});
    assert.equal(login.status,200);
    cookie=login.headers.get('set-cookie').split(';')[0];
    const client=await call('/clients','POST',{name:'Тестовый Клиент',email:'test@example.com',phone:'+7 900 000-00-00'});
    assert.equal(client.status,201);
    assert.equal((await call(`/clients/${client.data.id}`,'PUT',{name:'Новый Клиент',email:'new@example.com',phone:'+7 900 000-00-01'})).status,200);
    const lesson=await call('/classes','POST',{title:'Тестовое занятие',date:'2026-10-01',time:'15:00',duration:60,teacher:'Тестовый преподаватель',capacity:1});
    assert.equal(lesson.status,201);
    const classId=lesson.data.id;
    const booking=await call('/bookings','POST',{class_id:classId,client_id:client.data.id});
    assert.equal(booking.status,201);
    assert.equal((await call('/bookings','POST',{class_id:classId,client_id:client.data.id})).status,409);
    assert.equal((await call('/bookings','POST',{class_id:classId,client_id:1})).status,409);
    assert.equal((await call(`/classes/${classId}`,'PUT',{title:'Тестовое занятие',date:'2026-10-01',time:'15:00',duration:60,teacher:'Тестовый преподаватель',capacity:2})).status,200);
    assert.equal((await call('/bookings','POST',{class_id:classId,client_id:1})).status,201);
    assert.equal((await call(`/classes/${classId}`,'PUT',{title:'Тестовое занятие',date:'2026-10-01',time:'15:00',duration:60,teacher:'Тестовый преподаватель',capacity:1})).status,409);
    assert.equal((await call(`/bookings/${booking.data.id}`,'DELETE')).status,200);
    assert.equal((await call('/classes')).data.find(x=>x.id===classId).booked,1);
    const race=await call('/classes','POST',{title:'Последнее место',date:'2026-10-01',time:'18:00',duration:60,teacher:'Тестовый преподаватель',capacity:1});
    const results=await Promise.all([call('/bookings','POST',{class_id:race.data.id,client_id:client.data.id}),call('/bookings','POST',{class_id:race.data.id,client_id:2})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    await stop(child);child=await start(port,file);
    assert.equal((await call('/session')).data.authenticated,true);
    assert.equal((await call('/classes')).data.find(x=>x.id===classId).booked,1);
    assert.equal((await call('/clients')).data.find(x=>x.id===client.data.id).name,'Новый Клиент');
  } finally {await stop(child);fs.rmSync(dir,{recursive:true,force:true})}
});
