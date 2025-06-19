const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// מידלוור
app.use(cors({
    origin: ['https://remote.azriasolutions.com', 'https://tablocker-mobile.vercel.app'],
    credentials: true
}));
app.use(express.json());

// אתחול מסד נתונים SQLite
const dbPath = path.join(__dirname, 'tablocker.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database:', dbPath);
        initDatabase();
    }
});

// יצירת טבלאות
function initDatabase() {
    // טבלת מכשירים
    db.run(`CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        device_code TEXT NOT NULL,
        type TEXT DEFAULT 'chrome_extension',
        last_seen INTEGER,
        status TEXT DEFAULT 'online',
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )`, (err) => {
        if (err) console.error('Error creating devices table:', err);
        else console.log('Devices table ready');
    });

    // טבלת פקודות
    db.run(`CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        device_code TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        executed_at INTEGER,
        FOREIGN KEY (device_id) REFERENCES devices (id)
    )`, (err) => {
        if (err) console.error('Error creating commands table:', err);
        else console.log('Commands table ready');
    });

    // טבלת תגובות
    db.run(`CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        device_code TEXT NOT NULL,
        response_data TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices (id)
    )`, (err) => {
        if (err) console.error('Error creating responses table:', err);
        else console.log('Responses table ready');
    });
}

// פונקציה לחילוץ קוד מכשיר (6 ספרות אחרונות)
function extractDeviceCode(deviceId) {
    return deviceId.slice(-6).toUpperCase();
}

// נקיון תקופתי של נתונים ישנים
setInterval(() => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    
    // מחק פקודות ישנות (מעל שעה)
    db.run('DELETE FROM commands WHERE created_at < ? AND status = "completed"', [oneHourAgo]);
    
    // מחק תגובות ישנות (מעל שעה)  
    db.run('DELETE FROM responses WHERE created_at < ?', [oneHourAgo]);
    
    // עדכן סטטוס מכשירים שלא נראו זמן רב (מעל 10 דקות)
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    db.run('UPDATE devices SET status = "offline" WHERE last_seen < ?', [tenMinutesAgo]);
    
}, 300000); // כל 5 דקות

// **ENDPOINTS**

// בדיקת בריאות השרת
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        database: 'connected'
    });
});

// רישום מכשיר חדש
app.post('/api/register', (req, res) => {
    const { deviceId, type = 'chrome_extension' } = req.body;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'Device ID required' });
    }

    const deviceCode = extractDeviceCode(deviceId);
    const timestamp = Math.floor(Date.now() / 1000);

    const query = `INSERT OR REPLACE INTO devices (id, device_code, type, last_seen, status) 
                   VALUES (?, ?, ?, ?, 'online')`;
    
    db.run(query, [deviceId, deviceCode, type, timestamp], function(err) {
        if (err) {
            console.error('Registration error:', err);
            return res.status(500).json({ error: 'Registration failed' });
        }
        
        console.log(`Device registered: ${deviceId} (code: ${deviceCode})`);
        res.json({ 
            success: true, 
            deviceId, 
            deviceCode,
            message: 'Device registered successfully' 
        });
    });
});

// חיפוש מכשיר לפי קוד (6 ספרות)
app.post('/api/find-device', (req, res) => {
    const { deviceCode } = req.body;
    
    if (!deviceCode || deviceCode.length !== 6) {
        return res.status(400).json({ error: 'Invalid device code' });
    }

    const upperCode = deviceCode.toUpperCase();
    
    db.get('SELECT * FROM devices WHERE device_code = ? AND status = "online"', 
        [upperCode], (err, device) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!device) {
            return res.status(404).json({ error: 'Device not found or offline' });
        }
        
        // עדכן זמן ראייה אחרון
        const timestamp = Math.floor(Date.now() / 1000);
        db.run('UPDATE devices SET last_seen = ? WHERE id = ?', [timestamp, device.id]);
        
        res.json({
            found: true,
            device: {
                id: device.id,
                code: device.device_code,
                type: device.type,
                lastSeen: device.last_seen,
                status: device.status
            }
        });
    });
});

// שליחת פקודה למכשיר (עם קוד)
app.post('/api/send-command', (req, res) => {
    const { deviceCode, command } = req.body;
    
    if (!deviceCode || !command) {
        return res.status(400).json({ error: 'Device code and command required' });
    }

    const upperCode = deviceCode.toUpperCase();
    
    // חפש את המכשיר לפי קוד
    db.get('SELECT id FROM devices WHERE device_code = ? AND status = "online"', 
        [upperCode], (err, device) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!device) {
            return res.status(404).json({ error: 'Device not found or offline' });
        }
        
        // הוסף פקודה לתור
        const commandStr = JSON.stringify(command);
        const timestamp = Math.floor(Date.now() / 1000);
        
        db.run('INSERT INTO commands (device_id, device_code, command, created_at) VALUES (?, ?, ?, ?)',
            [device.id, upperCode, commandStr, timestamp], function(err) {
            if (err) {
                console.error('Command insertion error:', err);
                return res.status(500).json({ error: 'Failed to queue command' });
            }
            
            console.log(`Command queued for device ${upperCode}: ${command.action}`);
            res.json({ 
                success: true, 
                commandId: this.lastID,
                message: 'Command sent successfully' 
            });
        });
    });
});

// קבלת פקודות עבור מכשיר
app.get('/api/commands/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'Device ID required' });
    }

    // עדכן זמן ראייה אחרון
    const timestamp = Math.floor(Date.now() / 1000);
    db.run('UPDATE devices SET last_seen = ?, status = "online" WHERE id = ?', 
        [timestamp, deviceId]);

    // קבל פקודות ממתינות
    db.all('SELECT id, command FROM commands WHERE device_id = ? AND status = "pending" ORDER BY created_at ASC',
        [deviceId], (err, commands) => {
        if (err) {
            console.error('Commands retrieval error:', err);
            return res.status(500).json({ error: 'Failed to get commands' });
        }
        
        // סמן פקודות כמבוצעות
        if (commands.length > 0) {
            const commandIds = commands.map(c => c.id);
            const placeholders = commandIds.map(() => '?').join(',');
            const executeTimestamp = Math.floor(Date.now() / 1000);
            
            db.run(`UPDATE commands SET status = "completed", executed_at = ? WHERE id IN (${placeholders})`,
                [executeTimestamp, ...commandIds]);
        }
        
        // החזר פקודות מפוענחות
        const parsedCommands = commands.map(cmd => {
            try {
                return JSON.parse(cmd.command);
            } catch (e) {
                console.error('Command parsing error:', e);
                return { action: 'INVALID_COMMAND' };
            }
        });
        
        res.json(parsedCommands);
    });
});

// קבלת תגובה ממכשיר
app.post('/api/response', (req, res) => {
    const { deviceId, ...responseData } = req.body;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'Device ID required' });
    }

    const deviceCode = extractDeviceCode(deviceId);
    const timestamp = Math.floor(Date.now() / 1000);
    const responseStr = JSON.stringify(responseData);

    db.run('INSERT INTO responses (device_id, device_code, response_data, created_at) VALUES (?, ?, ?, ?)',
        [deviceId, deviceCode, responseStr, timestamp], function(err) {
        if (err) {
            console.error('Response insertion error:', err);
            return res.status(500).json({ error: 'Failed to save response' });
        }
        
        res.json({ success: true, responseId: this.lastID });
    });
});

// קבלת תגובות לפי קוד מכשיר (עבור האפליקציה)
app.get('/api/responses/:deviceCode', (req, res) => {
    const { deviceCode } = req.params;
    const upperCode = deviceCode.toUpperCase();
    
    // קבל תגובות מהשעה האחרונה
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    
    db.all('SELECT response_data, created_at FROM responses WHERE device_code = ? AND created_at > ? ORDER BY created_at DESC LIMIT 10',
        [upperCode, oneHourAgo], (err, responses) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to get responses' });
        }
        
        const parsedResponses = responses.map(r => {
            try {
                return {
                    ...JSON.parse(r.response_data),
                    timestamp: r.created_at
                };
            } catch (e) {
                return { error: 'Invalid response data', timestamp: r.created_at };
            }
        });
        
        res.json(parsedResponses);
    });
});

// סטטיסטיקות (אופציונלי)
app.get('/api/stats', (req, res) => {
    db.all(`
        SELECT 
            COUNT(*) as total_devices,
            SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online_devices,
            SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline_devices
        FROM devices
    `, (err, stats) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to get stats' });
        }
        
        res.json(stats[0] || { total_devices: 0, online_devices: 0, offline_devices: 0 });
    });
});

// טיפול בשגיאות
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// התחלת השרת
app.listen(PORT, () => {
    console.log(`🚀 Tab Locker API Server running on port ${PORT}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    console.log(`🔒 Database: ${dbPath}`);
});

// סגירה נקייה
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server gracefully...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('✅ Database connection closed');
        }
        process.exit(0);
    });
});