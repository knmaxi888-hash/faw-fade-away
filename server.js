const express = require("express");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const pino = require("pino");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const SESSION_DIR = path.join(__dirname, "wa-session");

const BARBER_PHONE = "5493718669138";

const HORARIOS = ["09:00","09:30","10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00"];

let sock = null;
let qrCode = null;
let waConnected = false;
let db = null;
let reservations = null;

const conversations = {};

function getConversation(phone) {
    if (!conversations[phone] || Date.now() - conversations[phone].lastActivity > 30 * 60 * 1000) {
        conversations[phone] = { step: "greeting", data: {}, lastActivity: Date.now() };
    }
    conversations[phone].lastActivity = Date.now();
    return conversations[phone];
}

app.use(express.json());

app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(express.static(__dirname));

async function connectDB() {
    if (!MONGODB_URI) {
        console.log("[DB] No MONGODB_URI configurada, usando JSON local");
        return;
    }
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db("faw");
        reservations = db.collection("reservations");
        await reservations.createIndex({ date: 1 });
        console.log("[DB] Conectado a MongoDB");
    } catch (e) {
        console.error("[DB] Error conectando:", e.message);
    }
}

app.get("/api/reservations", async (req, res) => {
    if (reservations) {
        const data = await reservations.find({}).sort({ createdAt: -1 }).toArray();
        res.json(data);
    } else {
        res.json([]);
    }
});

app.get("/api/reserved-times/:date", async (req, res) => {
    const date = req.params.date;
    if (reservations) {
        const reserved = await reservations
            .find({ date: date, status: { $ne: "cancelada" } })
            .toArray();
        res.json(reserved.map(r => r.time));
    } else {
        res.json([]);
    }
});

app.post("/api/reservations", async (req, res) => {
    const newReservation = {
        id: Date.now(),
        name: req.body.name,
        apellido: req.body.apellido,
        date: req.body.date,
        time: req.body.time,
        status: "pendiente",
        payment: "pendiente",
        createdAt: new Date().toISOString()
    };
    if (reservations) {
        await reservations.insertOne(newReservation);
    }
    res.json({ success: true, reservation: newReservation });
});

app.put("/api/reservations/:id", async (req, res) => {
    if (reservations) {
        const id = parseInt(req.params.id);
        const update = {};
        if (req.body.status) update.status = req.body.status;
        if (req.body.payment) update.payment = req.body.payment;
        await reservations.updateOne({ id: id }, { $set: update });
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "DB not connected" });
    }
});

app.delete("/api/reservations/:id", async (req, res) => {
    if (reservations) {
        const id = parseInt(req.params.id);
        await reservations.deleteOne({ id: id });
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "DB not connected" });
    }
});

app.get("/api/available-times/:date", async (req, res) => {
    const date = req.params.date;
    if (reservations) {
        const reserved = await reservations
            .find({ date: date, status: { $ne: "cancelada" } })
            .toArray();
        const reservedTimes = reserved.map(r => r.time);
        res.json(HORARIOS.filter(h => !reservedTimes.includes(h)));
    } else {
        res.json(HORARIOS);
    }
});

app.get("/api/wa-status", (req, res) => {
    res.json({ connected: waConnected, hasQR: !!qrCode });
});

app.get("/api/wa-qr", (req, res) => {
    if (qrCode) {
        res.json({ qr: qrCode });
    } else {
        res.json({ qr: null });
    }
});

async function handleWhatsAppMessage(phone, text) {
    const conv = getConversation(phone);
    const lower = text.toLowerCase();

    if (lower === "cancelar" || lower === "reset") {
        conv.step = "greeting";
        conv.data = {};
        await sendWhatsApp(phone, "Conversación reiniciada. ¿En qué te puedo ayudar?");
        return;
    }

    if (conv.step === "greeting") {
        conv.step = "ask_name";
        await sendWhatsApp(phone, "Hola! Bienvenido a Fade Away Barbershop. Soy el asistente virtual.\n\n¿Cuál es tu nombre?");
    } else if (conv.step === "ask_name") {
        conv.data.name = text;
        conv.step = "ask_apellido";
        await sendWhatsApp(phone, `Perfecto ${text}. ¿Cuál es tu apellido?`);
    } else if (conv.step === "ask_apellido") {
        conv.data.apellido = text;
        conv.step = "ask_date";
        await sendWhatsApp(phone, "¿Para qué día querés reservar? (podés escribir la fecha como 25/08 o 'hoy', 'mañana')");
    } else if (conv.step === "ask_date") {
        const date = parseDate(lower);
        if (!date) {
            await sendWhatsApp(phone, "No entendí la fecha. Escribila como 25/08, o decime 'hoy' o 'mañana'.");
            return;
        }
        const dayOfWeek = new Date(date + "T12:00:00").getDay();
        if (dayOfWeek === 0) {
            await sendWhatsApp(phone, "Los domingos estamos cerrados. ¿Qué otro día te viene bien?");
            return;
        }
        conv.data.date = date;
        const reserved = await getReservedTimes(date);
        const available = HORARIOS.filter(h => !reserved.includes(h));
        if (available.length === 0) {
            await sendWhatsApp(phone, `El día ${date} no hay horarios disponibles. ¿Qué otro día querés probar?`);
            return;
        }
        conv.step = "ask_time";
        conv.data.availableTimes = available;
        const horariosMsg = available.map(h => `• ${h}`).join("\n");
        await sendWhatsApp(phone, `El día ${date} tenemos estos horarios disponibles:\n\n${horariosMsg}\n\n¿Cuál te sirve?`);
    } else if (conv.step === "ask_time") {
        const selectedTime = conv.data.availableTimes.find(h => lower.includes(h));
        if (!selectedTime) {
            await sendWhatsApp(phone, "No entendí el horario. Escribilo como HH:MM (ej: 15:00).");
            return;
        }
        conv.data.time = selectedTime;
        const reservation = await createReservation(conv.data);
        conv.step = "done";
        await sendWhatsApp(phone, `Listo! Tu reserva quedó agendada:\n\n📅 Fecha: ${reservation.date}\n🕐 Hora: ${reservation.time}\n👤 Nombre: ${reservation.name} ${reservation.apellido}\n\nTe esperamos en Fade Away Barbershop.\nSi necesitás cancelar o cambiar algo, escribime!`);
        await notifyBarber(reservation);
    } else if (conv.step === "done") {
        conv.step = "greeting";
        conv.data = {};
        await sendWhatsApp(phone, "¿Querés hacer otra reserva o necesitás algo más?");
    }
}

function parseDate(text) {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    if (text.includes("hoy")) {
        return formatDate(today);
    }
    if (text.includes("mañana")) {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return formatDate(tomorrow);
    }
    const match = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (match) {
        const day = match[1].padStart(2, "0");
        const month = match[2].padStart(2, "0");
        const year = today.getFullYear();
        const dateStr = `${year}-${month}-${day}`;
        const testDate = new Date(dateStr + "T12:00:00");
        if (testDate < today) {
            testDate.setFullYear(testDate.getFullYear() + 1);
        }
        return formatDate(testDate);
    }
    return null;
}

function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

async function getReservedTimes(date) {
    if (reservations) {
        const reserved = await reservations
            .find({ date: date, status: { $ne: "cancelada" } })
            .toArray();
        return reserved.map(r => r.time);
    }
    return [];
}

async function createReservation(data) {
    const newReservation = {
        id: Date.now(),
        name: data.name,
        apellido: data.apellido,
        date: data.date,
        time: data.time,
        status: "pendiente",
        payment: "pendiente",
        createdAt: new Date().toISOString()
    };
    if (reservations) {
        await reservations.insertOne(newReservation);
    }
    return newReservation;
}

async function sendWhatsApp(to, text) {
    if (!sock || !waConnected) {
        console.log(`[WA NO CONECTADO] Para: ${to} | Mensaje: ${text}`);
        return;
    }
    try {
        const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: text });
        console.log(`[WA OK] Mensaje enviado a ${to}`);
    } catch (e) {
        console.error("[WA ERROR]", e.message);
    }
}

async function notifyBarber(reservation) {
    const msg = `🔔 *Nueva reserva*\n\n📅 ${reservation.date} a las ${reservation.time}\n👤 ${reservation.name} ${reservation.apellido}\n\nEntrá a admin para gestionarla.`;
    await sendWhatsApp(BARBER_PHONE, msg);
}

async function startWhatsApp() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        printQRInTerminal: true,
        logger: pino({ level: "silent" })
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCode = qr;
            waConnected = false;
            console.log("[WA] QR Code generado - escaneá desde /qr");
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[WA] Conexión cerrada. Razón: ${reason}`);

            if (reason !== DisconnectReason.loggedOut) {
                console.log("[WA] Reconectando...");
                qrCode = null;
                waConnected = false;
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log("[WA] Sesión cerrada. Necesitás escanear el QR de nuevo.");
                qrCode = null;
                waConnected = false;
                try { fs.rmSync(SESSION_DIR, { recursive: true }); } catch(e) {}
                setTimeout(startWhatsApp, 3000);
            }
        }

        if (connection === "open") {
            qrCode = null;
            waConnected = true;
            console.log("[WA] ¡Conectado a WhatsApp!");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message?.conversation) {
            const phone = msg.key.remoteJid.replace("@s.whatsapp.net", "");
            const text = msg.message.conversation.trim();
            console.log(`[WA MSG] De: ${phone} | ${text}`);
            await handleWhatsAppMessage(phone, text);
        }
    });
}

app.get("/qr", (req, res) => {
    res.sendFile(path.join(__dirname, "qr.html"));
});

app.listen(PORT, async () => {
    console.log(`FAW Server corriendo en http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log(`QR Code: http://localhost:${PORT}/qr`);
    await connectDB();
    startWhatsApp();
});
