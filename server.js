const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// תוקן: שימוש בקובץ במקום בזיכרון
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        type TEXT,
        last_seen INTEGER
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT,
        command TEXT,
        executed INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT,
        response TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )`);
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: Date.now() });
});

app.post('/api/register', (req, res) => {
    const { deviceId, type } = req.body;
    const currentTime = Math.floor(Date.now() / 1000);
    
    db.run('INSERT OR REPLACE INTO devices (id, type, last_seen) VALUES (?, ?, ?)',
        [deviceId, type, currentTime], function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json({ success: true, deviceId });
            }
        });
});

app.get('/api/commands/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const currentTime = Math.floor(Date.now() / 1000);
    
    db.run('UPDATE devices SET last_seen = ? WHERE id = ?', [currentTime, deviceId]);
    
    db.all('SELECT * FROM commands WHERE device_id = ? AND executed = 0',
        [deviceId], (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                if (rows.length > 0) {
                    const commandIds = rows.map(r => r.id);
                    const placeholders = commandIds.map(() => '?').join(',');
                    db.run(`UPDATE commands SET executed = 1 WHERE id IN (${placeholders})`, commandIds);
                }
                
                const commands = rows.map(row => JSON.parse(row.command));
                res.json(commands);
            }
        });
});

app.post('/api/send-command', (req, res) => {
    const { deviceId, command } = req.body;
    
    db.run('INSERT INTO commands (device_id, command) VALUES (?, ?)',
        [deviceId, JSON.stringify(command)], function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json({ success: true, commandId: this.lastID });
            }
        });
});

app.post('/api/response', (req, res) => {
    const { deviceId, ...responseData } = req.body;
    
    db.run('INSERT INTO responses (device_id, response) VALUES (?, ?)',
        [deviceId, JSON.stringify(responseData)], function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json({ success: true });
            }
        });
});

app.get('/api/status/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    
    db.get('SELECT * FROM responses WHERE device_id = ? ORDER BY created_at DESC LIMIT 1',
        [deviceId], (err, row) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else if (row) {
                res.json(JSON.parse(row.response));
            } else {
                res.json({ status: 'no_data' });
            }
        });
});

app.get('/api/devices', (req, res) => {
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    
    db.all('SELECT * FROM devices WHERE last_seen > ?', [fiveMinutesAgo], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows);
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});