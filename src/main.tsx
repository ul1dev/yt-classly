import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CalendarDays, UsersRound, ClipboardList, ChevronLeft, ChevronRight, ChevronDown, Plus, X, LogOut, Pencil, Search, Check, Menu } from 'lucide-react';
import './styles.css';

type Lesson = {id:number;title:string;date:string;time:string;duration:number;teacher:string;capacity:number;booked:number};
type Client = {id:number;name:string;email:string;phone:string};
type Booking = {id:number;class_id:number;client_id:number;client_name:string;email:string;phone:string;title:string;date:string;time:string;teacher:string};
type Section = 'schedule'|'clients'|'bookings';
type Modal = 'lesson'|'client'|'booking'|null;
const sections: {id:Section;label:string;icon:typeof CalendarDays}[] = [
  {id:'schedule',label:'Расписание',icon:CalendarDays},{id:'clients',label:'Клиенты',icon:UsersRound},{id:'bookings',label:'Записи',icon:ClipboardList}
];
const fmtDay = (day:string,opts:Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',...opts}).format(new Date(day+'T12:00:00Z'));
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const shift = (day:string,amount:number) => {const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+amount);return d.toISOString().slice(0,10)};
const monday = (day:string) => {const d=new Date(day+'T12:00:00Z');return shift(day,-((d.getUTCDay()+6)%7))};
const endTime = (time:string,duration:number) => {const [h,m]=time.split(':').map(Number);const total=h*60+m+duration;return `${String(Math.floor(total/60)%24).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`};
async function api<T>(url:string,options?:RequestInit):Promise<T> {
  const response=await fetch('/api'+url,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...options});
  const data=await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос');
  return data as T;
}
const emptyLesson={title:'',date:today(),time:'10:00',duration:60,teacher:'',capacity:12};
const emptyClient={name:'',email:'',phone:''};

function App(){
  const [authorized,setAuthorized]=useState<boolean|null>(null);
  const [password,setPassword]=useState('');
  const [section,setSection]=useState<Section>('schedule');
  const [lessons,setLessons]=useState<Lesson[]>([]);
  const [clients,setClients]=useState<Client[]>([]);
  const [bookings,setBookings]=useState<Booking[]>([]);
  const [selectedDay,setSelectedDay]=useState(today());
  const [selectedId,setSelectedId]=useState<number|null>(null);
  const [modal,setModal]=useState<Modal>(null);
  const [editingId,setEditingId]=useState<number|null>(null);
  const [lessonForm,setLessonForm]=useState(emptyLesson);
  const [clientForm,setClientForm]=useState(emptyClient);
  const [bookingClass,setBookingClass]=useState<number|null>(null);
  const [bookingClient,setBookingClient]=useState('');
  const [search,setSearch]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const [mobileMenu,setMobileMenu]=useState(false);

  const load=async()=>{
    const [a,b,c]=await Promise.all([api<Lesson[]>('/classes'),api<Client[]>('/clients'),api<Booking[]>('/bookings')]);
    setLessons(a);setClients(b);setBookings(c);
  };
  useEffect(()=>{api<{authenticated:boolean}>('/session').then(r=>{setAuthorized(r.authenticated);if(r.authenticated)load().catch(e=>setError(e.message))}).catch(()=>setAuthorized(false))},[]);
  useEffect(()=>{if(notice){const timer=setTimeout(()=>setNotice(''),3500);return()=>clearTimeout(timer)}},[notice]);
  const week=useMemo(()=>Array.from({length:7},(_,i)=>shift(monday(selectedDay),i)),[selectedDay]);
  const dayLessons=lessons.filter(l=>l.date===selectedDay);
  const selected=dayLessons.find(l=>l.id===selectedId) || null;
  useEffect(()=>{if(dayLessons.length && !dayLessons.some(l=>l.id===selectedId)) setSelectedId(dayLessons[0].id)},[selectedDay,lessons,selectedId]);
  const participants=bookings.filter(b=>b.class_id===selected?.id);
  const shownClients=clients.filter(c=>(c.name+' '+c.email+' '+c.phone).toLowerCase().includes(search.toLowerCase()));
  const shownBookings=bookings.filter(b=>(b.client_name+' '+b.title+' '+b.date).toLowerCase().includes(search.toLowerCase()));
  const closeModal=()=>{setModal(null);setError('');setEditingId(null)};
  const action=async(fn:()=>Promise<unknown>,success:string)=>{
    setBusy(true);setError('');
    try {await fn();await load();closeModal();setNotice(success)}
    catch(e){setError((e as Error).message)}
    finally{setBusy(false)}
  };
  const login=(e:React.FormEvent)=>{e.preventDefault();action(async()=>{await api('/login',{method:'POST',body:JSON.stringify({password})});setAuthorized(true);await load();setPassword('')},'Добро пожаловать')};
  const openLesson=(lesson?:Lesson)=>{setEditingId(lesson?.id??null);setLessonForm(lesson?{title:lesson.title,date:lesson.date,time:lesson.time,duration:lesson.duration,teacher:lesson.teacher,capacity:lesson.capacity}:{...emptyLesson,date:selectedDay});setError('');setModal('lesson')};
  const openClient=(client?:Client)=>{setEditingId(client?.id??null);setClientForm(client?{name:client.name,email:client.email,phone:client.phone}:emptyClient);setError('');setModal('client')};
  const openBooking=(classId?:number)=>{setBookingClass(classId??selected?.id??null);setBookingClient('');setError('');setModal('booking')};
  const saveLesson=(e:React.FormEvent)=>{e.preventDefault();action(()=>api('/classes'+(editingId?'/'+editingId:''),{method:editingId?'PUT':'POST',body:JSON.stringify(lessonForm)}),editingId?'Занятие обновлено':'Занятие создано')};
  const saveClient=(e:React.FormEvent)=>{e.preventDefault();action(()=>api('/clients'+(editingId?'/'+editingId:''),{method:editingId?'PUT':'POST',body:JSON.stringify(clientForm)}),editingId?'Клиент обновлён':'Клиент добавлен')};
  const saveBooking=(e:React.FormEvent)=>{e.preventDefault();action(()=>api('/bookings',{method:'POST',body:JSON.stringify({class_id:bookingClass,client_id:Number(bookingClient)})}),'Клиент записан')};
  const cancelBooking=(booking:Booking)=>{if(!window.confirm(`Отменить запись: ${booking.client_name} — ${booking.title}?`))return;action(()=>api('/bookings/'+booking.id,{method:'DELETE'}),'Запись отменена')};
  if(authorized===null) return <div className="loading">Загрузка студии…</div>;
  if(!authorized) return <div className="login-page"><div className="login-card"><div className="brand-mark"><CalendarDays size={24}/><span>Студия</span></div><h1>Добро пожаловать</h1><p>Войдите, чтобы управлять занятиями и записями.</p><form onSubmit={login}><label>Пароль владельца<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoFocus required autoComplete="current-password"/></label>{error&&<div className="form-error">{error}</div>}<button className="primary full" disabled={busy}>Войти</button></form></div></div>;
  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark"><CalendarDays size={22}/><span>Студия</span></div><nav className="desktop-nav">{sections.map(s=><button key={s.id} className={section===s.id?'nav-item active':'nav-item'} onClick={()=>{setSection(s.id);setSearch('')}}><s.icon size={19}/>{s.label}</button>)}</nav><div className="top-actions"><span className="today-label">{fmtDay(today(),{weekday:'long',day:'numeric',month:'long'})}</span><button className="icon-button logout" title="Выйти" onClick={()=>api('/logout',{method:'POST'}).then(()=>setAuthorized(false))}><LogOut size={19}/></button><button className="icon-button mobile-menu-button" onClick={()=>setMobileMenu(!mobileMenu)} aria-label="Меню"><Menu size={22}/></button></div></header>
    {mobileMenu&&<div className="mobile-menu"><button onClick={()=>{api('/logout',{method:'POST'}).then(()=>setAuthorized(false));setMobileMenu(false)}}><LogOut size={18}/> Выйти</button></div>}
    <main className="main">
      {section==='schedule'&&<><div className="page-header"><div><h1>Расписание</h1><p>Занятия и участники студии</p></div><button className="primary" onClick={()=>openLesson()}><Plus size={19}/> Создать занятие</button></div>
        <div className="week-toolbar"><button className="square-button" onClick={()=>setSelectedDay(shift(selectedDay,-7))} aria-label="Предыдущая неделя"><ChevronLeft size={19}/></button><strong>{fmtDay(week[0],{day:'numeric',month:'long'})} — {fmtDay(week[6],{day:'numeric',month:'long',year:'numeric'})}</strong><button className="square-button" onClick={()=>setSelectedDay(shift(selectedDay,7))} aria-label="Следующая неделя"><ChevronRight size={19}/></button><button className="today-button" onClick={()=>setSelectedDay(today())}>Сегодня</button></div>
        <div className="weekdays">{week.map(day=><button key={day} className={selectedDay===day?'day active':'day'} onClick={()=>{setSelectedDay(day);setSelectedId(null)}}><span>{fmtDay(day,{weekday:'short'})}</span><strong>{fmtDay(day,{day:'numeric',month:'short'})}</strong></button>)}</div>
        <div className="schedule-layout"><section className="lesson-list"><h2>{fmtDay(selectedDay,{weekday:'long',day:'numeric',month:'long'})}</h2>{dayLessons.length===0?<div className="empty">На этот день занятий пока нет.<button className="text-button" onClick={()=>openLesson()}>Создать занятие</button></div>:dayLessons.map(lesson=><React.Fragment key={lesson.id}><button className={selected?.id===lesson.id?'lesson-row selected':'lesson-row'} onClick={()=>setSelectedId(lesson.id)}><div className="lesson-time"><strong>{lesson.time}</strong><span>{lesson.duration} мин</span></div><div className="lesson-name"><strong>{lesson.title}</strong><span>{lesson.teacher}</span></div><div className="lesson-spots"><span>{lesson.booked} / {lesson.capacity}</span><div className="progress"><i style={{width:`${lesson.booked/lesson.capacity*100}%`}}/></div></div><ChevronRight className="row-chevron" size={18}/></button>{selected?.id===lesson.id&&<div className="mobile-detail"><div className="mobile-detail-meta"><span>{lesson.teacher} · {lesson.duration} мин</span><button className="icon-button" title="Редактировать занятие" onClick={()=>openLesson(lesson)}><Pencil size={16}/></button></div><strong>Участники ({participants.length})</strong><div className="mobile-participants">{participants.length?participants.map(b=><div className="mobile-participant" key={b.id}><span>{b.client_name}</span><button className="icon-button tiny" title="Отменить запись" onClick={()=>cancelBooking(b)}><X size={16}/></button></div>):<p>Пока никто не записан</p>}</div><button className="primary full" disabled={lesson.booked>=lesson.capacity} onClick={()=>openBooking(lesson.id)}><Plus size={17}/> Записать клиента</button></div>}</React.Fragment>)}</section>
        <aside className="detail-panel">{selected?<><div className="detail-head"><div><h2>{selected.title}</h2><p>{fmtDay(selected.date,{weekday:'long',day:'numeric',month:'long'})} · {selected.time}–{endTime(selected.time,selected.duration)} ({selected.duration} мин)</p><p>{selected.teacher}</p></div><button className="icon-button" title="Редактировать занятие" onClick={()=>openLesson(selected)}><Pencil size={18}/></button></div><div className="detail-tabs"><strong>Участники ({participants.length})</strong><span>{selected.capacity-selected.booked} свободно</span></div><div className="participants">{participants.length?participants.map((b,i)=><div className="participant" key={b.id}><span className="participant-index">{i+1}</span><span className="avatar">{b.client_name.split(' ').map(x=>x[0]).slice(0,2).join('')}</span><span>{b.client_name}</span><button className="icon-button tiny" title="Отменить запись" onClick={()=>cancelBooking(b)}><X size={16}/></button></div>):<p className="muted">Пока никто не записан.</p>}</div><div className="detail-bottom"><span>Свободные места <strong>{selected.capacity-selected.booked} из {selected.capacity}</strong></span><button className="primary full" disabled={selected.booked>=selected.capacity} onClick={()=>openBooking(selected.id)}><Plus size={18}/> Записать клиента</button></div></>:<div className="detail-placeholder"><CalendarDays size={30}/><h2>Выберите занятие</h2><p>Здесь появятся участники и подробности занятия.</p></div>}</aside></div></>}
      {section==='clients'&&<><div className="page-header"><div><h1>Клиенты</h1><p>{clients.length} клиентов в студии</p></div><button className="primary" onClick={()=>openClient()}><Plus size={19}/> Добавить клиента</button></div><div className="list-toolbar"><div className="search"><Search size={18}/><input placeholder="Поиск по имени, почте или телефону" value={search} onChange={e=>setSearch(e.target.value)}/></div></div><div className="data-table clients-table"><div className="table-head"><span>Клиент</span><span>Email</span><span>Телефон</span><span></span></div>{shownClients.map(c=><div className="table-row" key={c.id}><div className="person-cell"><span className="avatar">{c.name.split(' ').map(x=>x[0]).slice(0,2).join('')}</span><strong>{c.name}</strong></div><span>{c.email}</span><span>{c.phone}</span><button className="icon-button" title="Редактировать" onClick={()=>openClient(c)}><Pencil size={17}/></button></div>)}{!shownClients.length&&<div className="empty">Клиенты не найдены.</div>}</div></>}
      {section==='bookings'&&<><div className="page-header"><div><h1>Записи</h1><p>{bookings.length} активных записей</p></div><button className="primary" onClick={()=>openBooking()}><Plus size={19}/> Новая запись</button></div><div className="list-toolbar"><div className="search"><Search size={18}/><input placeholder="Поиск по клиенту или занятию" value={search} onChange={e=>setSearch(e.target.value)}/></div></div><div className="data-table bookings-table"><div className="table-head"><span>Клиент</span><span>Занятие</span><span>Дата и время</span><span></span></div>{shownBookings.map(b=><div className="table-row" key={b.id}><div className="person-cell"><span className="avatar">{b.client_name.split(' ').map(x=>x[0]).slice(0,2).join('')}</span><strong>{b.client_name}</strong></div><span>{b.title}</span><span>{fmtDay(b.date,{day:'numeric',month:'long',year:'numeric'})} · {b.time}</span><button className="cancel-button" onClick={()=>cancelBooking(b)}>Отменить</button></div>)}{!shownBookings.length&&<div className="empty">Записи не найдены.</div>}</div></>}
    </main>
    <nav className="bottom-nav">{sections.map(s=><button key={s.id} className={section===s.id?'active':''} onClick={()=>{setSection(s.id);setSearch('')}}><s.icon size={21}/><span>{s.label}</span></button>)}</nav>
    {notice&&<div className="toast"><Check size={18}/>{notice}</div>}
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)closeModal()}}><div className="modal" role="dialog" aria-modal="true"><div className="modal-header"><div><h2>{modal==='lesson'?(editingId?'Редактировать занятие':'Новое занятие'):modal==='client'?(editingId?'Редактировать клиента':'Новый клиент'):'Записать клиента'}</h2><p>{modal==='booking'?'Выберите занятие и клиента':'Заполните данные ниже'}</p></div><button className="icon-button" onClick={closeModal} aria-label="Закрыть"><X size={20}/></button></div>
      {modal==='lesson'&&<form onSubmit={saveLesson} className="form-grid"><label className="wide">Название занятия<input required value={lessonForm.title} onChange={e=>setLessonForm({...lessonForm,title:e.target.value})} placeholder="Например, пилатес"/></label><label>Дата<input type="date" required value={lessonForm.date} onChange={e=>setLessonForm({...lessonForm,date:e.target.value})}/></label><label>Время<input type="time" required value={lessonForm.time} onChange={e=>setLessonForm({...lessonForm,time:e.target.value})}/></label><label>Длительность, мин<input type="number" min="5" max="480" required value={lessonForm.duration} onChange={e=>setLessonForm({...lessonForm,duration:Number(e.target.value)})}/></label><label>Количество мест<input type="number" min="1" max="1000" required value={lessonForm.capacity} onChange={e=>setLessonForm({...lessonForm,capacity:Number(e.target.value)})}/></label><label className="wide">Преподаватель<input required value={lessonForm.teacher} onChange={e=>setLessonForm({...lessonForm,teacher:e.target.value})} placeholder="Имя преподавателя"/></label>{error&&<div className="form-error wide">{error}</div>}<div className="form-actions wide"><button type="button" className="secondary" onClick={closeModal}>Отмена</button><button className="primary" disabled={busy}>{editingId?'Сохранить':'Создать занятие'}</button></div></form>}
      {modal==='client'&&<form onSubmit={saveClient} className="form-grid"><label className="wide">Имя<input required value={clientForm.name} onChange={e=>setClientForm({...clientForm,name:e.target.value})} placeholder="Имя и фамилия"/></label><label className="wide">Email<input type="email" required value={clientForm.email} onChange={e=>setClientForm({...clientForm,email:e.target.value})} placeholder="name@example.com"/></label><label className="wide">Телефон<input type="tel" required value={clientForm.phone} onChange={e=>setClientForm({...clientForm,phone:e.target.value})} placeholder="+7 999 000-00-00"/></label>{error&&<div className="form-error wide">{error}</div>}<div className="form-actions wide"><button type="button" className="secondary" onClick={closeModal}>Отмена</button><button className="primary" disabled={busy}>{editingId?'Сохранить':'Добавить клиента'}</button></div></form>}
      {modal==='booking'&&<form onSubmit={saveBooking} className="form-grid"><label className="wide">Занятие<select required value={bookingClass??''} onChange={e=>setBookingClass(Number(e.target.value))}><option value="">Выберите занятие</option>{lessons.map(l=><option key={l.id} value={l.id} disabled={l.booked>=l.capacity}>{fmtDay(l.date,{day:'numeric',month:'short'})}, {l.time} — {l.title} ({l.capacity-l.booked} мест)</option>)}</select></label><label className="wide">Клиент<select required value={bookingClient} onChange={e=>setBookingClient(e.target.value)}><option value="">Выберите клиента</option>{clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{error&&<div className="form-error wide">{error}</div>}<div className="form-actions wide"><button type="button" className="secondary" onClick={closeModal}>Отмена</button><button className="primary" disabled={busy||!bookingClass||!bookingClient}>Записать клиента</button></div></form>}</div></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
