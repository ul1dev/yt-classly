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
  const child=spawn(process.execPath,['server/index.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DB_PATH:file,ADMIN_EMAIL:'admin@studio.test',OWNER_PASSWORD_HASH:bcrypt.hashSync('test-password',4),NODE_ENV:'test'},stdio:'ignore'});
  for(let i=0;i<80;i++){
    if(child.exitCode!==null) throw new Error('Server exited');
    try {await fetch(`http://127.0.0.1:${port}/api/session`);return child} catch {await new Promise(r=>setTimeout(r,50))}
  }
  child.kill();throw new Error('Server did not start');
}
async function stop(child){child.kill();await new Promise(r=>child.once('exit',r))}

test('role access, card linking, bookings, email uniqueness and restart',async()=>{
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
    const addDays=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
    const futureDate=addDays(7),overlapDate=addDays(10),endDate=addDays(30),outsideDate=addDays(31),farEndDate=addDays(45);
    assert.equal((await call('/classes')).status,401);
    assert.equal((await call('/login','POST',{email:'admin@studio.test',password:'wrong'})).status,401);
    const admin=await call('/login','POST',{email:'admin@studio.test',password:'test-password'});
    assert.equal(admin.data.role,'admin');
    const adminCookie=admin.headers.get('set-cookie').split(';')[0];
    cookie=adminCookie;
    const lesson=await call('/classes','POST',{title:'Тестовое занятие',date:futureDate,time:'15:00',duration:60,teacher:'Тестовый преподаватель',capacity:1});
    assert.equal(lesson.status,201);
    const classId=lesson.data.id;
    assert.equal((await call('/clients','POST',{name:'Дубль',email:'ALINA@EXAMPLE.COM',phone:'+7 900 000-00-00'})).status,409);
    cookie='';
    const linked=await call('/register','POST',{name:'Новое имя',email:'ALINA@EXAMPLE.COM',phone:'+7 900 000-00-00',password:'client-password'});
    assert.equal(linked.status,201);
    assert.equal(linked.data.role,'client');
    const clientCookie=linked.headers.get('set-cookie').split(';')[0];
    cookie=clientCookie;
    assert.equal((await call('/clients')).status,403);
    assert.equal((await call('/membership-events')).status,403);
    assert.equal((await call('/memberships','POST',{client_id:1,total_visits:4,starts_on:futureDate,ends_on:endDate})).status,403);
    assert.equal((await call('/classes','POST',{title:'Запрещено',date:futureDate,time:'16:00',duration:60,teacher:'X',capacity:1})).status,403);
    assert.equal((await call(`/classes/${classId}`,'PUT',{title:'Запрещено',date:futureDate,time:'16:00',duration:60,teacher:'X',capacity:1})).status,403);
    assert.equal((await call(`/classes/${classId}/cancel`,'POST')).status,403);
    const ownBefore=await call('/bookings');
    assert.equal(ownBefore.data.length,28);
    assert.ok(ownBefore.data.every(b=>!('client_name' in b) && !('phone' in b)));
    assert.equal((await call('/register','POST',{name:'Дубль',email:'alina@example.com',phone:'+7 900 000-00-00',password:'client-password'})).status,409);
    assert.equal((await call('/bookings','POST',{class_id:classId})).status,409);
    cookie=adminCookie;
    const firstMembership=await call('/memberships','POST',{client_id:1,total_visits:4,starts_on:futureDate,ends_on:endDate});
    assert.equal(firstMembership.status,201);
    assert.equal((await call('/memberships','POST',{client_id:2,total_visits:8,starts_on:futureDate,ends_on:endDate})).status,201);
    assert.equal((await call('/memberships','POST',{client_id:1,total_visits:4,starts_on:overlapDate,ends_on:farEndDate})).status,201);
    cookie=clientCookie;
    assert.equal((await call('/memberships')).data.length,2);
    const own=await call('/bookings','POST',{class_id:classId,client_id:2});
    assert.equal(own.status,201);
    assert.equal((await call('/bookings','POST',{class_id:classId})).status,409);
    assert.equal((await call('/bookings')).data.length,29);
    assert.equal((await call('/memberships')).data.find(m=>m.id===firstMembership.data.id).remaining_visits,3);
    cookie=adminCookie;
    const all=await call('/bookings');
    const booked=all.data.find(b=>b.id===own.data.id);
    assert.equal(booked.client_id,1);
    const other=all.data.find(b=>b.client_id===2);
    assert.equal((await call('/bookings','POST',{class_id:classId,client_id:2})).status,409);
    assert.equal((await call(`/classes/${classId}`,'PUT',{title:'Тестовое занятие',date:futureDate,time:'15:00',duration:60,teacher:'Тестовый преподаватель',capacity:2})).status,200);
    assert.equal((await call(`/classes/${classId}`,'PUT',{title:'Тестовое занятие',date:outsideDate,time:'15:00',duration:60,teacher:'Тестовый преподаватель',capacity:2})).status,409);
    const second=await call('/bookings','POST',{class_id:classId,client_id:2});
    assert.equal(second.status,201);
    assert.equal((await call(`/classes/${classId}`,'PUT',{title:'Тестовое занятие',date:futureDate,time:'15:00',duration:60,teacher:'Тестовый преподаватель',capacity:1})).status,409);
    cookie=clientCookie;
    assert.equal((await call(`/bookings/${other.id}`,'DELETE')).status,404);
    assert.equal((await call(`/bookings/${own.data.id}/cancellation-preview`)).data.willRefund,true);
    assert.equal((await call(`/bookings/${own.data.id}`,'DELETE')).status,200);
    assert.equal((await call('/bookings')).data.length,28);
    assert.equal((await call('/memberships')).data.find(m=>m.id===firstMembership.data.id).remaining_visits,4);
    cookie=adminCookie;
    assert.deepEqual((await call('/membership-events')).data.filter(e=>e.client_name==='Алина Смирнова').map(e=>e.delta),[1,-1]);
    assert.equal((await call('/classes')).data.find(x=>x.id===classId).booked,1);
    assert.equal((await call(`/classes/${classId}/cancel`,'POST')).data.refunded,1);
    assert.equal((await call(`/classes/${classId}/cancel`,'POST')).data.refunded,0);
    assert.equal((await call('/classes')).data.find(x=>x.id===classId).status,'cancelled');
    assert.equal((await call('/bookings','POST',{class_id:classId,client_id:2})).status,409);
    assert.equal((await call(`/classes/${classId}`,'PUT',{title:'Тестовое занятие',date:futureDate,time:'15:00',duration:60,teacher:'Тестовый преподаватель',capacity:2})).status,409);
    await stop(child);child=await start(port,file);
    cookie=clientCookie;
    assert.equal((await call('/session')).data.role,'client');
    assert.equal((await call('/bookings')).data.length,28);
    cookie='';
    const fresh=await call('/register','POST',{name:'Новый клиент',email:'fresh@example.com',phone:'+7 900 000-00-01',password:'fresh-password'});
    assert.equal(fresh.status,201);
    cookie=fresh.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/bookings')).data.length,0);
    cookie=adminCookie;
    assert.equal((await call('/clients')).data.length,9);
  } finally {await stop(child);fs.rmSync(dir,{recursive:true,force:true})}
});

test('series API creates occurrences once and scopes edits to non-exceptions',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-series-api-'));
  const file=path.join(dir,'studio.db');
  const port=await freePort();
  let child=await start(port,file);
  let cookie='';
  const call=async(route,method='GET',body)=>{
    const response=await fetch(`http://127.0.0.1:${port}/api${route}`,{method,headers:{'Content-Type':'application/json',cookie},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  try {
    const admin=await call('/login','POST',{email:'admin@studio.test',password:'test-password'});
    cookie=admin.headers.get('set-cookie').split(';')[0];
    const addDays=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
    const today=new Date().toISOString().slice(0,10);
    const weekday=new Date(today+'T12:00:00Z').getUTCDay()||7;
    const startsOn=addDays(today,8-weekday);
    const endsOn=addDays(startsOn,27);
    const base={title:'Йога по расписанию',time:'19:00',duration:60,teacher:'Анна',capacity:8};
    const series=await call('/series','POST',{...base,starts_on:startsOn,ends_on:endsOn,weekdays:[2,4]});
    assert.equal(series.status,201);
    assert.equal(series.data.count,8);
    const original=(await call('/classes')).data.filter(row=>row.series_id===series.data.id);
    assert.equal(original.length,8);
    assert.ok(original.every(row=>row.booked===0&&row.is_exception===0));
    cookie='';
    const client=await call('/register','POST',{name:'Проверка',email:'series@example.com',phone:'+7 900 123-45-67',password:'client-password'});
    cookie=client.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/series','POST',{...base,starts_on:startsOn,ends_on:endsOn,weekdays:[2,4]})).status,403);
    assert.equal((await call(`/classes/${original[1].id}`,'PUT',{...base,date:original[1].date,scope:'future'})).status,403);
    cookie=admin.headers.get('set-cookie').split(';')[0];
    const exception=await call(`/classes/${original[2].id}`,'PUT',{...base,title:'Особая йога',date:original[2].date,scope:'single'});
    assert.equal(exception.status,200);
    const future=await call(`/classes/${original[1].id}`,'PUT',{...base,time:'20:00',date:original[1].date,scope:'future'});
    assert.equal(future.status,200);
    assert.equal(future.data.updated,6);
    const after=(await call('/classes')).data.filter(row=>row.series_id===series.data.id);
    assert.equal(after.length,8);
    assert.equal(after[0].time,'19:00');
    assert.equal(after[1].time,'20:00');
    assert.equal(after[2].title,'Особая йога');
    assert.equal(after[2].time,'19:00');
    assert.equal((await call(`/classes/${original[3].id}/cancel`,'POST')).status,200);
    assert.equal((await call('/classes')).data.find(row=>row.id===original[4].id).status,'active');
    await stop(child);child=await start(port,file);
    assert.equal((await call('/classes')).data.filter(row=>row.series_id===series.data.id).length,8);
  } finally {await stop(child);fs.rmSync(dir,{recursive:true,force:true})}
});

test('branches isolate administrators while clients share accounts and select eligible passes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-branches-'));
  const file=path.join(dir,'studio.db');
  const port=await freePort();
  let child=await start(port,file),cookie='';
  const call=async(route,method='GET',body)=>{
    const response=await fetch(`http://127.0.0.1:${port}/api${route}`,{method,headers:{'Content-Type':'application/json',cookie},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  try{
    const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    const end=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
    const owner=await call('/login','POST',{email:'admin@studio.test',password:'test-password'});
    cookie=owner.headers.get('set-cookie').split(';')[0];
    assert.equal(owner.data.isOwner,true);
    const branches=await call('/branches');
    assert.deepEqual(branches.data.map(b=>b.id),[1,2]);
    const classBody={title:'Йога',date,time:'19:00',duration:60,teacher:'Анна',capacity:3};
    const first=await call('/classes','POST',{...classBody,branch_id:1});
    const second=await call('/classes','POST',{...classBody,branch_id:2});
    assert.equal(first.status,201);assert.equal(second.status,201);
    const both=await call('/memberships','POST',{client_id:1,total_visits:4,starts_on:date,ends_on:end,branch_id:null});
    const onlySecond=await call('/memberships','POST',{client_id:1,total_visits:8,starts_on:date,ends_on:end,branch_id:2});
    assert.equal(both.status,201);assert.equal(onlySecond.status,201);
    assert.equal((await call('/branch-admins','POST',{email:'branch2@studio.test',password:'branch-password',branch_id:2})).status,201);
    cookie='';
    const client=await call('/register','POST',{name:'Алина',email:'alina@example.com',phone:'+7 999 111-11-11',password:'client-password'});
    cookie=client.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/classes?branch_id=1')).data.some(l=>l.id===first.data.id),true);
    assert.equal((await call('/classes?branch_id=2')).data.some(l=>l.id===second.data.id),true);
    assert.equal((await call('/bookings','POST',{class_id:second.data.id})).status,409);
    const booking=await call('/bookings','POST',{class_id:second.data.id,membership_id:onlySecond.data.id});
    assert.equal(booking.status,201);
    assert.equal((await call('/memberships')).data.find(m=>m.id===onlySecond.data.id).remaining_visits,7);
    assert.equal((await call('/memberships')).data.find(m=>m.id===both.data.id).remaining_visits,4);
    assert.equal((await call(`/bookings/${booking.data.id}`,'DELETE')).status,200);
    assert.equal((await call('/memberships')).data.find(m=>m.id===onlySecond.data.id).remaining_visits,8);
    assert.equal((await call('/bookings','POST',{class_id:first.data.id,membership_id:onlySecond.data.id})).status,409);
    cookie='';
    const branchAdmin=await call('/login','POST',{email:'branch2@studio.test',password:'branch-password'});
    cookie=branchAdmin.headers.get('set-cookie').split(';')[0];
    assert.equal(branchAdmin.data.branchId,2);
    assert.equal((await call('/branches')).data.length,1);
    assert.equal((await call('/classes')).data.every(l=>l.branch_id===2),true);
    assert.equal((await call('/classes?branch_id=1')).status,403);
    assert.equal((await call(`/classes/${first.data.id}/cancel`,'POST')).status,403);
    assert.equal((await call('/classes','POST',{...classBody,branch_id:1})).status,403);
    assert.equal((await call('/memberships','POST',{client_id:1,total_visits:4,starts_on:date,ends_on:end,branch_id:1})).status,403);
    assert.equal((await call('/memberships','POST',{client_id:1,total_visits:4,starts_on:date,ends_on:end,branch_id:null})).status,403);
    assert.equal((await call('/bookings','POST',{class_id:first.data.id,client_id:1,membership_id:both.data.id})).status,403);
    assert.equal((await call('/clients','POST',{name:'X',email:'x@example.com',phone:'+7 999 111-11-11'})).status,403);
    assert.equal((await call('/branch-admins')).status,403);
    await stop(child);child=await start(port,file);
    cookie=owner.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/memberships')).data.find(m=>m.id===onlySecond.data.id).remaining_visits,8);
    assert.equal((await call('/classes?branch_id=2')).data.some(l=>l.id===second.data.id),true);
  } finally {await stop(child);fs.rmSync(dir,{recursive:true,force:true})}
});
