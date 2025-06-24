const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// מידלוור - תיקון CORS כדי לאפשר גישה מתוספי Chrome
app.use(cors({
    origin: function(origin, callback) {
        // אפשר גישה מתוספי Chrome (אין להם origin רגיל)
        const allowedOrigins = [
            'https://remote.azriasolutions.com',
            'https://tablocker-mobile.vercel.app',
            'http://localhost:3000', // לפיתוח
            'http://localhost:5000'  // לפיתוח
        ];
        
        // אם אין origin (כמו בתוספי Chrome) או שה-origin מורשה
        if (!origin || allowedOrigins.includes(origin) || origin.startsWith('chrome-extension://')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
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
        else console.log('✅ Devices table ready');
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
        else console.log('✅ Commands table ready');
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
        else console.log('✅ Responses table ready');
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
    
    console.log('🧹 Cleanup completed');
}, 300000); // כל 5 דקות

// **ENDPOINTS**

// בדיקת בריאות השרת - מעודכן
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        database: 'connected',
        version: '2.0.0',
        server: 'Tab Locker API Server',
        endpoints: {
            register: '/api/register',
            findDevice: '/api/find-device', 
            sendCommand: '/api/send-command',
            commands: '/api/commands/:deviceId',
            response: '/api/response',
            responses: '/api/responses/:deviceCode'
        }
    });
});

// Ping endpoint עבור התוסף
app.post('/api/ping', (req, res) => {
    const { deviceId } = req.body;
    
    if (deviceId) {
        // עדכן last_seen
        const timestamp = Math.floor(Date.now() / 1000);
        db.run('UPDATE devices SET last_seen = ?, status = "online" WHERE id = ?', 
            [timestamp, deviceId]);
    }
    
    res.json({ 
        status: 'pong', 
        timestamp: Date.now(),
        message: 'Server is alive'
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
        
        console.log(`✅ Device registered: ${deviceId} (code: ${deviceCode})`);
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
        return res.status(400).json({ 
            error: 'Invalid device code',
            found: false 
        });
    }

    const upperCode = deviceCode.toUpperCase();
    
    // בדוק אם הקוד תקין (רק A-F, 0-9)
    if (!/^[A-F0-9]{6}$/.test(upperCode)) {
        return res.status(400).json({ 
            error: 'Invalid code format',
            found: false 
        });
    }
    
    db.get('SELECT * FROM devices WHERE device_code = ? AND status = "online"', 
        [upperCode], (err, device) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ 
                error: 'Database error',
                found: false 
            });
        }
        
        if (!device) {
            console.log(`❌ Device not found: ${upperCode}`);
            return res.json({ 
                found: false,
                error: 'Device not found or offline' 
            });
        }
        
        // עדכן זמן ראייה אחרון
        const timestamp = Math.floor(Date.now() / 1000);
        db.run('UPDATE devices SET last_seen = ? WHERE id = ?', [timestamp, device.id]);
        
        console.log(`✅ Device found: ${upperCode}`);
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
            return res.status(404).json({ 
                error: 'Device not found or offline',
                success: false 
            });
        }
        
        // הוסף פקודה לתור
        const commandStr = JSON.stringify(command);
        const timestamp = Math.floor(Date.now() / 1000);
        
        db.run('INSERT INTO commands (device_id, device_code, command, created_at) VALUES (?, ?, ?, ?)',
            [device.id, upperCode, commandStr, timestamp], function(err) {
            if (err) {
                console.error('Command insertion error:', err);
                return res.status(500).json({ 
                    error: 'Failed to queue command',
                    success: false 
                });
            }
            
            console.log(`📤 Command queued for device ${upperCode}: ${command.action}`);
            res.json({ 
                success: true, 
                commandId: this.lastID,
                message: 'Command sent successfully' 
            });
        });
    });
});

// קבלת פקודות עבור מכשיר (polling מהתוסף)
app.get('/api/commands/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'Device ID required' });
    }

    // עדכן זמן ראייה אחרון
    const timestamp = Math.floor(Date.now() / 1000);
    db.run('UPDATE devices SET last_seen = ?, status = "online" WHERE id = ?', 
        [timestamp, deviceId], (updateErr) => {
        if (updateErr) {
            console.error('Update error:', updateErr);
        }
    });

    // קבל פקודות ממתינות
    db.all('SELECT id, command FROM commands WHERE device_id = ? AND status = "pending" ORDER BY created_at ASC LIMIT 10',
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
                [executeTimestamp, ...commandIds], (updateErr) => {
                if (updateErr) {
                    console.error('Command update error:', updateErr);
                }
            });
            
            console.log(`📥 Sending ${commands.length} commands to device ${deviceId}`);
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

    // עדכן last_seen
    db.run('UPDATE devices SET last_seen = ? WHERE id = ?', [timestamp, deviceId]);

    db.run('INSERT INTO responses (device_id, device_code, response_data, created_at) VALUES (?, ?, ?, ?)',
        [deviceId, deviceCode, responseStr, timestamp], function(err) {
        if (err) {
            console.error('Response insertion error:', err);
            return res.status(500).json({ error: 'Failed to save response' });
        }
        
        console.log(`💾 Response saved from device ${deviceCode}: ${responseData.status || 'unknown'}`);
        res.json({ success: true, responseId: this.lastID });
    });
});

// קבלת תגובות לפי קוד מכשיר (עבור האפליקציה) - תיקון
app.get('/api/responses/:deviceCode', (req, res) => {
    const { deviceCode } = req.params;
    const upperCode = deviceCode.toUpperCase();
    
    console.log(`📥 Getting responses for device: ${upperCode}`);
    
    // קבל תגובות מ-5 הדקות האחרונות
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    
    db.all('SELECT response_data, created_at FROM responses WHERE device_code = ? AND created_at > ? ORDER BY created_at DESC LIMIT 10',
        [upperCode, fiveMinutesAgo], (err, responses) => {
        if (err) {
            console.error('❌ Failed to get responses:', err);
            return res.status(500).json({ error: 'Failed to get responses' });
        }
        
        console.log(`📨 Found ${responses.length} responses for ${upperCode}`);
        
        // פענח תגובות
        const parsedResponses = responses.map(r => {
            try {
                return {
                    ...JSON.parse(r.response_data),
                    timestamp: r.created_at
                };
            } catch (e) {
                console.error('❌ Failed to parse response:', e);
                return { error: 'Invalid response data', timestamp: r.created_at };
            }
        });
        
        // מחק תגובות שנקראו (רק אם יש תגובות)
        if (responses.length > 0) {
            const oldestTimestamp = responses[responses.length - 1].created_at;
            db.run('DELETE FROM responses WHERE device_code = ? AND created_at <= ?', 
                [upperCode, oldestTimestamp], (deleteErr) => {
                if (deleteErr) {
                    console.error('⚠️ Failed to cleanup responses:', deleteErr);
                }
            });
        }
        
        res.json(parsedResponses);
    });
});

// סטטיסטיקות (אופציונלי)
app.get('/api/stats', (req, res) => {
    const queries = {
        devices: new Promise((resolve, reject) => {
            db.get(`
                SELECT 
                    COUNT(*) as total_devices,
                    SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online_devices,
                    SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline_devices
                FROM devices
            `, (err, row) => {
                if (err) reject(err);
                else resolve(row || { total_devices: 0, online_devices: 0, offline_devices: 0 });
            });
        }),
        commands: new Promise((resolve, reject) => {
            db.get(`
                SELECT 
                    COUNT(*) as total_commands,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_commands,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_commands
                FROM commands
                WHERE created_at > strftime('%s', 'now') - 3600
            `, (err, row) => {
                if (err) reject(err);
                else resolve(row || { total_commands: 0, pending_commands: 0, completed_commands: 0 });
            });
        })
    };

    Promise.all([queries.devices, queries.commands])
        .then(([devices, commands]) => {
            res.json({
                devices,
                commands,
                server: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    timestamp: new Date().toISOString()
                }
            });
        })
        .catch(err => {
            res.status(500).json({ error: 'Failed to get stats' });
        });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        path: req.path,
        method: req.method
    });
});

// טיפול בשגיאות
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// התחלת השרת
app.listen(PORT, () => {
    console.log(`🚀 Tab Locker API Server running on port ${PORT}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Stats: http://localhost:${PORT}/api/stats`);
    console.log(`🔒 Database: ${dbPath}`);
    console.log(`🌍 CORS enabled for Chrome extensions and known origins`);
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

// טיפול בשגיאות לא צפויות
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});