import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dateInMoscow = (offset = 0) => {
  const base = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(base);
};

export function openDb(file = process.env.DB_PATH || './data/studio.db') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    INSERT OR IGNORE INTO branches (id,name) VALUES (1,'Первый филиал'),(2,'Второй филиал');
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      duration INTEGER NOT NULL CHECK(duration > 0),
      teacher TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK(capacity > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS class_series (
      id INTEGER PRIMARY KEY,
      starts_on TEXT NOT NULL,
      ends_on TEXT NOT NULL,
      weekdays TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(starts_on <= ends_on)
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      client_id INTEGER NOT NULL REFERENCES clients(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(class_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS booking_id_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE INDEX IF NOT EXISTS idx_classes_date ON classes(date, time);
    CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id);
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('client','admin')),
      client_id INTEGER UNIQUE REFERENCES clients(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK((role='client' AND client_id IS NOT NULL) OR (role='admin' AND client_id IS NULL))
    );
    CREATE TABLE IF NOT EXISTS client_merge_archive (
      id INTEGER PRIMARY KEY,
      canonical_client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TEXT NOT NULL,
      merged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS booking_merge_archive (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL,
      original_client_id INTEGER NOT NULL,
      canonical_client_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      merged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      total_visits INTEGER NOT NULL CHECK(total_visits IN (4,8)),
      remaining_visits INTEGER NOT NULL CHECK(remaining_visits BETWEEN 0 AND total_visits),
      starts_on TEXT NOT NULL,
      ends_on TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(starts_on <= ends_on)
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_client_dates ON memberships(client_id,starts_on,ends_on);
    CREATE TABLE IF NOT EXISTS membership_events (
      id INTEGER PRIMARY KEY,
      membership_id INTEGER NOT NULL REFERENCES memberships(id),
      booking_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      client_id INTEGER NOT NULL REFERENCES clients(id),
      delta INTEGER NOT NULL CHECK(delta IN (-1,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_membership_events_membership ON membership_events(membership_id,id);
  `);
  db.transaction(() => {
    if (!db.pragma('table_info(classes)').some(column => column.name === 'branch_id')) {
      db.exec('ALTER TABLE classes ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 1');
    }
    if (!db.pragma('table_info(class_series)').some(column => column.name === 'branch_id')) {
      db.exec('ALTER TABLE class_series ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 1');
    }
    if (!db.pragma('table_info(memberships)').some(column => column.name === 'branch_id')) {
      db.exec('ALTER TABLE memberships ADD COLUMN branch_id INTEGER REFERENCES branches(id)');
      db.exec('UPDATE memberships SET branch_id=1 WHERE branch_id IS NULL');
    }
    if (!db.pragma('table_info(accounts)').some(column => column.name === 'branch_id')) {
      db.exec('ALTER TABLE accounts ADD COLUMN branch_id INTEGER REFERENCES branches(id)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_classes_branch_date ON classes(branch_id,date,time)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memberships_branch_client ON memberships(branch_id,client_id)');
    if (!db.pragma('table_info(classes)').some(column => column.name === 'series_id')) {
      db.exec('ALTER TABLE classes ADD COLUMN series_id INTEGER REFERENCES class_series(id)');
    }
    if (!db.pragma('table_info(classes)').some(column => column.name === 'occurrence_date')) {
      db.exec('ALTER TABLE classes ADD COLUMN occurrence_date TEXT');
    }
    if (!db.pragma('table_info(classes)').some(column => column.name === 'is_exception')) {
      db.exec('ALTER TABLE classes ADD COLUMN is_exception INTEGER NOT NULL DEFAULT 0 CHECK(is_exception IN (0,1))');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS classes_series_occurrence_unique ON classes(series_id,occurrence_date) WHERE series_id IS NOT NULL');
    if (!db.pragma('table_info(classes)').some(column => column.name === 'status')) {
      db.exec("ALTER TABLE classes ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled'))");
    }
    if (!db.pragma('table_info(classes)').some(column => column.name === 'cancelled_at')) {
      db.exec('ALTER TABLE classes ADD COLUMN cancelled_at TEXT');
    }
    if (!db.pragma('table_info(bookings)').some(column => column.name === 'membership_id')) {
      db.exec('ALTER TABLE bookings ADD COLUMN membership_id INTEGER REFERENCES memberships(id)');
    }
    const columns = db.pragma('table_info(sessions)');
    if (!columns.some(column => column.name === 'user_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES accounts(id)');
      db.exec('DELETE FROM sessions WHERE user_id IS NULL');
    }
    const clients = db.prepare('SELECT * FROM clients ORDER BY id').all();
    const canonicalByEmail = new Map();
    for (const client of clients) {
      const email = client.email.trim().toLowerCase();
      const canonical = canonicalByEmail.get(email);
      if (canonical) {
        const bookings = db.prepare('SELECT * FROM bookings WHERE client_id=?').all(client.id);
        for (const booking of bookings) {
          if (db.prepare('SELECT id FROM bookings WHERE class_id=? AND client_id=?').get(booking.class_id, canonical)) {
            db.prepare('INSERT OR IGNORE INTO booking_merge_archive (id,class_id,original_client_id,canonical_client_id,created_at) VALUES (?,?,?,?,?)')
              .run(booking.id, booking.class_id, client.id, canonical, booking.created_at);
            db.prepare('DELETE FROM bookings WHERE id=?').run(booking.id);
          } else {
            db.prepare('UPDATE bookings SET client_id=? WHERE id=?').run(canonical, booking.id);
          }
        }
        db.prepare('INSERT OR IGNORE INTO client_merge_archive (id,canonical_client_id,name,email,phone,created_at) VALUES (?,?,?,?,?,?)')
          .run(client.id, canonical, client.name, client.email, client.phone, client.created_at);
        db.prepare('DELETE FROM clients WHERE id=?').run(client.id);
      } else {
        canonicalByEmail.set(email, client.id);
        if (client.email !== email) db.prepare('UPDATE clients SET email=? WHERE id=?').run(email, client.id);
      }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS clients_email_unique ON clients(email COLLATE NOCASE)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS clients_email_normalized_unique ON clients(lower(trim(email)))');
  }).immediate();
  // Seed only a genuinely new database. Existing owner data is never overwritten.
  if (db.prepare('SELECT COUNT(*) AS count FROM classes').get().count === 0 &&
      db.prepare('SELECT COUNT(*) AS count FROM clients').get().count === 0) {
    db.transaction(() => {
      const client = db.prepare('INSERT INTO clients (name,email,phone) VALUES (?,?,?)');
      const names = [
        ['Алина Смирнова','alina@example.com','+7 999 101-20-30'],
        ['Ольга Иванова','olga@example.com','+7 999 102-20-30'],
        ['Екатерина Лебедева','ekaterina@example.com','+7 999 103-20-30'],
        ['Мария Петрова','maria@example.com','+7 999 104-20-30'],
        ['Дарья Кузнецова','daria@example.com','+7 999 105-20-30'],
        ['Светлана Миронова','svetlana@example.com','+7 999 106-20-30'],
        ['Полина Власова','polina@example.com','+7 999 107-20-30'],
        ['Наталья Соколова','natalia@example.com','+7 999 108-20-30'],
      ];
      names.forEach(item => client.run(...item));
      const lesson = db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity,branch_id) VALUES (?,?,?,?,?,?,1)');
      const lessons = [
        ['Утренняя йога','08:00',60,'Анна Кузнецова',14],
        ['Пилатес','10:00',50,'Мария Соколова',12],
        ['Функциональная тренировка','12:00',60,'Игорь Павлов',12],
        ['Растяжка и мобильность','19:00',60,'Елена Морозова',14],
      ];
      for (let day = 0; day < 7; day++) {
        for (const [title,time,duration,teacher,capacity] of lessons) lesson.run(title,dateInMoscow(day),time,duration,teacher,capacity);
      }
      const book = db.prepare('INSERT INTO bookings (class_id,client_id) VALUES (?,?)');
      for (let id = 1; id <= 28; id++) {
        const n = id % 4 === 2 ? 8 : id % 4 === 1 ? 6 : 5;
        for (let clientId = 1; clientId <= n; clientId++) book.run(id,clientId);
      }
    })();
  }
  return db;
}

export function classRows(db, branchId = null) {
  const query=`SELECT c.*, COUNT(b.id) AS booked FROM classes c LEFT JOIN bookings b ON b.class_id=c.id ${branchId===null?'':'WHERE c.branch_id=?'} GROUP BY c.id ORDER BY c.date,c.time,c.id`;
  return branchId===null?db.prepare(query).all():db.prepare(query).all(branchId);
}

const dayNumber = date => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
const dateFromDayNumber = day => new Date(day * 86400000).toISOString().slice(0,10);

export function createSeries(db, data) {
  const first=dayNumber(data.starts_on),last=dayNumber(data.ends_on);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last<first || last-first>366) return {error:'Период серии должен быть от 1 до 367 дней',status:400};
  const days=[];
  for (let day=first;day<=last;day++) {
    const weekday=new Date(day*86400000).getUTCDay() || 7;
    if (data.weekdays.includes(weekday)) days.push(dateFromDayNumber(day));
  }
  if (!days.length) return {error:'В выбранном периоде нет занятий по указанным дням недели',status:400};
  return db.transaction(() => {
    const branchId=data.branch_id??1;
    if (!db.prepare('SELECT id FROM branches WHERE id=?').get(branchId)) return {error:'Филиал не найден',status:404};
    const series=db.prepare('INSERT INTO class_series (starts_on,ends_on,weekdays,branch_id) VALUES (?,?,?,?)').run(data.starts_on,data.ends_on,JSON.stringify(data.weekdays),branchId);
    const insert=db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity,series_id,occurrence_date,branch_id) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const date of days) insert.run(data.title,date,data.time,data.duration,data.teacher,data.capacity,series.lastInsertRowid,date,branchId);
    return {id:series.lastInsertRowid,count:days.length,firstDate:days[0]};
  }).immediate();
}

export function updateClass(db, classId, data, scope='single') {
  return db.transaction(() => {
    const lesson=db.prepare('SELECT * FROM classes WHERE id=?').get(classId);
    if (!lesson) return {status:404,error:'Занятие не найдено'};
    if (lesson.status === 'cancelled') return {status:409,error:'Отменённое занятие нельзя редактировать'};
    if (scope === 'future' && (!lesson.series_id || lesson.is_exception)) return {status:409,error:'Для этого занятия недоступно изменение серии'};
    const targets=scope==='future'
      ? db.prepare("SELECT * FROM classes WHERE series_id=? AND occurrence_date>=? AND is_exception=0 AND status='active' ORDER BY occurrence_date,id").all(lesson.series_id,lesson.occurrence_date)
      : [lesson];
    const shiftDays=dayNumber(data.date)-dayNumber(lesson.date);
    for (const target of targets) {
      const date=scope==='future'?dateFromDayNumber(dayNumber(target.date)+shiftDays):data.date;
      const count=db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE class_id=?').get(target.id).count;
      if (data.capacity<count) return {status:409,error:`На занятие ${target.date} уже записано ${count} клиентов. Мест не может быть меньше.`};
      if (db.prepare(`SELECT b.id FROM bookings b JOIN memberships m ON m.id=b.membership_id WHERE b.class_id=? AND (m.starts_on>? OR m.ends_on<?) LIMIT 1`).get(target.id,date,date)) return {status:409,error:`Дата занятия ${target.date} выходит за срок абонемента записанного клиента`};
    }
    const update=db.prepare('UPDATE classes SET title=?,date=?,time=?,duration=?,teacher=?,capacity=?,is_exception=? WHERE id=?');
    for (const target of targets) {
      const date=scope==='future'?dateFromDayNumber(dayNumber(target.date)+shiftDays):data.date;
      const changed=target.title!==data.title || target.date!==date || target.time!==data.time || target.duration!==data.duration || target.teacher!==data.teacher || target.capacity!==data.capacity;
      update.run(data.title,date,data.time,data.duration,data.teacher,data.capacity,scope==='single'&&target.series_id&&changed?1:target.is_exception,target.id);
    }
    return {ok:true,updated:targets.length};
  }).immediate();
}

export function createBooking(db, classId, clientId, membershipId = null) {
  return db.transaction(() => {
    const lesson = db.prepare('SELECT capacity,date,status,branch_id FROM classes WHERE id=?').get(classId);
    if (!lesson) return { error: 'Занятие не найдено', status: 404 };
    if (lesson.status === 'cancelled') return { error:'Занятие отменено', status:409 };
    if (!db.prepare('SELECT id FROM clients WHERE id=?').get(clientId)) return { error: 'Клиент не найден', status: 404 };
    if (db.prepare('SELECT id FROM bookings WHERE class_id=? AND client_id=?').get(classId,clientId)) return { error: 'Клиент уже записан на это занятие', status: 409 };
    const count = db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE class_id=?').get(classId).count;
    if (count >= lesson.capacity) return { error: 'Свободных мест нет', status: 409 };
    const eligible=db.prepare('SELECT id FROM memberships WHERE client_id=? AND (branch_id=? OR branch_id IS NULL) AND starts_on<=? AND ends_on>=? AND remaining_visits>0 ORDER BY starts_on DESC,id DESC').all(clientId,lesson.branch_id,lesson.date,lesson.date);
    if (!eligible.length) return { error: 'Нет подходящего абонемента с посещениями на дату занятия', status: 409 };
    const membership=membershipId===null?(eligible.length===1?eligible[0]:null):eligible.find(item=>item.id===membershipId);
    if (!membership) return { error:membershipId===null?'Выберите абонемент для записи':'Абонемент не подходит для этого занятия', status:409 };
    const maxId=db.prepare(`SELECT MAX(id) AS id FROM (SELECT id FROM bookings UNION ALL SELECT booking_id AS id FROM membership_events UNION ALL SELECT id FROM booking_merge_archive)`).get().id;
    if (maxId !== null) db.prepare('INSERT OR IGNORE INTO booking_id_sequence (id) VALUES (?)').run(maxId);
    const bookingId=db.prepare('INSERT INTO booking_id_sequence DEFAULT VALUES').run().lastInsertRowid;
    const result = db.prepare('INSERT INTO bookings (id,class_id,client_id,membership_id) VALUES (?,?,?,?)').run(bookingId,classId,clientId,membership.id);
    db.prepare('UPDATE memberships SET remaining_visits=remaining_visits-1 WHERE id=?').run(membership.id);
    db.prepare('INSERT INTO membership_events (membership_id,booking_id,class_id,client_id,delta) VALUES (?,?,?,?,-1)').run(membership.id,result.lastInsertRowid,classId,clientId);
    return { id: result.lastInsertRowid };
  }).immediate();
}

export function createMembership(db, clientId, totalVisits, startsOn, endsOn, branchId = 1) {
  return db.transaction(() => {
    if (!db.prepare('SELECT id FROM clients WHERE id=?').get(clientId)) return { error:'Клиент не найден', status:404 };
    if (branchId!==null && !db.prepare('SELECT id FROM branches WHERE id=?').get(branchId)) return {error:'Филиал не найден',status:404};
    const result=db.prepare('INSERT INTO memberships (client_id,total_visits,remaining_visits,starts_on,ends_on,branch_id) VALUES (?,?,?,?,?,?)').run(clientId,totalVisits,totalVisits,startsOn,endsOn,branchId);
    return { id:result.lastInsertRowid };
  }).immediate();
}

const lessonStartMs = (date,time) => Date.parse(`${date}T${time}:00+03:00`);

export function bookingCancellationPreview(db, bookingId, clientId = null, nowMs = Date.now()) {
  const booking=clientId === null
    ? db.prepare('SELECT b.id,b.membership_id,l.date,l.time,l.title FROM bookings b JOIN classes l ON l.id=b.class_id WHERE b.id=?').get(bookingId)
    : db.prepare('SELECT b.id,b.membership_id,l.date,l.time,l.title FROM bookings b JOIN classes l ON l.id=b.class_id WHERE b.id=? AND b.client_id=?').get(bookingId,clientId);
  if (!booking) return {error:'Запись не найдена',status:404};
  return {willRefund:booking.membership_id !== null && lessonStartMs(booking.date,booking.time)-nowMs >= 6*60*60*1000,legacy:booking.membership_id === null};
}

export function cancelBooking(db, bookingId, clientId = null, nowMs = Date.now()) {
  return db.transaction(() => {
    const booking=clientId === null
      ? db.prepare('SELECT b.*,l.date,l.time FROM bookings b JOIN classes l ON l.id=b.class_id WHERE b.id=?').get(bookingId)
      : db.prepare('SELECT b.*,l.date,l.time FROM bookings b JOIN classes l ON l.id=b.class_id WHERE b.id=? AND b.client_id=?').get(bookingId,clientId);
    if (!booking) return { error:'Запись не найдена', status:404 };
    const willRefund=booking.membership_id !== null && lessonStartMs(booking.date,booking.time)-nowMs >= 6*60*60*1000;
    if (willRefund) {
      db.prepare('UPDATE memberships SET remaining_visits=remaining_visits+1 WHERE id=?').run(booking.membership_id);
      db.prepare('INSERT INTO membership_events (membership_id,booking_id,class_id,client_id,delta) VALUES (?,?,?,?,1)').run(booking.membership_id,booking.id,booking.class_id,booking.client_id);
    }
    db.prepare('DELETE FROM bookings WHERE id=?').run(booking.id);
    return { ok:true,refunded:willRefund };
  }).immediate();
}

export function cancelClass(db, classId) {
  return db.transaction(() => {
    const lesson=db.prepare('SELECT id,status FROM classes WHERE id=?').get(classId);
    if (!lesson) return {error:'Занятие не найдено',status:404};
    if (lesson.status === 'cancelled') return {ok:true,alreadyCancelled:true,cancelledBookings:0,refunded:0};
    const bookings=db.prepare('SELECT id,class_id,client_id,membership_id FROM bookings WHERE class_id=?').all(classId);
    const outstanding=db.prepare(`SELECT membership_id,booking_id,class_id,client_id,-SUM(delta) AS owed
      FROM membership_events WHERE class_id=? GROUP BY membership_id,booking_id,class_id,client_id HAVING SUM(delta)<0`).all(classId);
    let refunded=0;
    for (const debit of outstanding) {
      for (let i=0;i<debit.owed;i++) {
        db.prepare('UPDATE memberships SET remaining_visits=remaining_visits+1 WHERE id=?').run(debit.membership_id);
        db.prepare('INSERT INTO membership_events (membership_id,booking_id,class_id,client_id,delta) VALUES (?,?,?,?,1)').run(debit.membership_id,debit.booking_id,debit.class_id,debit.client_id);
        refunded++;
      }
    }
    db.prepare('DELETE FROM bookings WHERE class_id=?').run(classId);
    db.prepare("UPDATE classes SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE id=?").run(classId);
    return {ok:true,alreadyCancelled:false,cancelledBookings:bookings.length,refunded};
  }).immediate();
}
