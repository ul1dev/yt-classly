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
    CREATE INDEX IF NOT EXISTS idx_classes_date ON classes(date, time);
    CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id);
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
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
      const lesson = db.prepare('INSERT INTO classes (title,date,time,duration,teacher,capacity) VALUES (?,?,?,?,?,?)');
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

export function classRows(db) {
  return db.prepare(`SELECT c.*, COUNT(b.id) AS booked FROM classes c LEFT JOIN bookings b ON b.class_id=c.id GROUP BY c.id ORDER BY c.date,c.time,c.id`).all();
}

export function createBooking(db, classId, clientId) {
  return db.transaction(() => {
    const lesson = db.prepare('SELECT capacity FROM classes WHERE id=?').get(classId);
    if (!lesson) return { error: 'Занятие не найдено', status: 404 };
    if (!db.prepare('SELECT id FROM clients WHERE id=?').get(clientId)) return { error: 'Клиент не найден', status: 404 };
    if (db.prepare('SELECT id FROM bookings WHERE class_id=? AND client_id=?').get(classId,clientId)) return { error: 'Клиент уже записан на это занятие', status: 409 };
    const count = db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE class_id=?').get(classId).count;
    if (count >= lesson.capacity) return { error: 'Свободных мест нет', status: 409 };
    const result = db.prepare('INSERT INTO bookings (class_id,client_id) VALUES (?,?)').run(classId,clientId);
    return { id: result.lastInsertRowid };
  }).immediate();
}
