// --- KONFIGURASI ---
require('dotenv').config();
// Ambil nilai dari .env
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET1_NAME = process.env.SHEET1_NAME;
const SHEET2_NAME = process.env.SHEET2_NAME;
// Nama file kredensial JSON yang Anda unduh
const CREDENTIALS_PATH = require('path').join(__dirname, 'credentials.json');
// Harga per 30 menit untuk setiap relay
const RELAY_PRICES = {
    "1": Number(process.env.RELAY1_HARGA),
    "2": Number(process.env.RELAY2_HARGA),
    "3": Number(process.env.RELAY3_HARGA),
    "4": Number(process.env.RELAY4_HARGA),
    "5": Number(process.env.RELAY5_HARGA),
    "6": Number(process.env.RELAY6_HARGA),
    "7": Number(process.env.RELAY7_HARGA),
    "8": Number(process.env.RELAY8_HARGA)
};

// --- Inisialisasi Aplikasi ---
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
app.use(bodyParser.json());

// --- Google Sheets Auth ---
const creds = require(CREDENTIALS_PATH);
const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// --- LOGGING SETUP ---
const logFilePath = path.join(__dirname, 'activity.log');
/**
 * Menulis pesan log ke konsol dan ke file log.
 * @param {string} message Pesan log.
 */
function logActivity(message) {
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFile(logFilePath, logMessage, (err) => {
        if (err) console.error('Gagal menulis ke file log:', err);
    });
    console.log(logMessage.trim());
}

// Cron job untuk membersihkan log setiap hari pada pukul 01:00 AM.
cron.schedule('0 1 * * *', () => {
    fs.writeFile(logFilePath, '', (err) => {
        logActivity(err ? 'ERROR: Gagal membersihkan file log.' : 'INFO: File log telah dibersihkan.');
    });
}, { scheduled: true, timezone: "Asia/Jakarta" });

// --- STATE MANAGEMENT ---
// Objek untuk menyimpan status ON/OFF setiap relay
let relayStatus = { "1": "off", "2": "off", "3": "off", "4": "off", "5": "off", "6": "off", "7": "off", "8": "off" };
// Objek untuk menyimpan referensi timer (setTimeout) untuk setiap relay
let relayTimers = {};
// Objek untuk menyimpan waktu berakhirnya timer (timestamp) untuk setiap relay
let relayTimerEndTimes = {};
// Objek untuk menyimpan chat_id dan message_id dari pesan bot yang berisi tombol relay
let relayMessageIds = {};
// Objek untuk menyimpan data penggunaan relay sementara (start time, duration)
let relayUsageData = {};

// --- GLOBAL COLOR DEFINITIONS (DIPINDAHKAN KE SINI) ---
const headerColorsSheet1 = [
    { red: 0.85, green: 0.85, blue: 0.85 }, // Abu-abu
    { red: 0.76, green: 0.87, blue: 0.98 }, // Biru
    { red: 0.98, green: 0.85, blue: 0.76 }, // Oranye
    { red: 1.00, green: 0.95, blue: 0.76 }, // Kuning
    { red: 0.82, green: 0.93, blue: 0.82 }, // Hijau
    { red: 0.98, green: 0.79, blue: 0.81 }  // Merah
];
const rowColorEven = { red: 0.90, green: 0.90, blue: 0.90 }; // Abu-abu sangat muda untuk baris genap
const rowColorOdd = { red: 1, green: 1, blue: 1 };         // Putih untuk baris ganjil

// --- FUNGSI GOOGLE SHEETS ---
/**
 * Menambahkan dan memformat baris data ke Google Sheet (Sheet1).
 * Fungsi ini akan memeriksa keberadaan header dan membuat/memformatnya jika belum ada.
 * Juga menerapkan warna selang-seling pada baris data.
 * @param {object} data Objek berisi data yang akan ditambahkan:
 * - date: Tanggal penggunaan (string)
 * - channel: Nomor relay (string)
 * - duration: Durasi penggunaan dalam menit (number)
 * - usageTime: Rentang waktu penggunaan (string, misal "09:00 - 10:00")
 * - totalPrice: Total harga dalam format mata uang (string)
 */
async function appendToSheet(data) {
    try {
        await doc.loadInfo();
        const sheet = await getOrCreateSheet(SHEET1_NAME, doc);

        const expectedHeaders = ['No', 'Tanggal', 'Relay', 'Durasi (Menit)', 'Waktu Pakai', 'Total Harga'];

        try {
            await sheet.loadHeaderRow();
        } catch (error) {
            if (error.message.includes('No values in the header row')) {
                logActivity('SHEETS: Header Sheet1 tidak ada. Membuat dan memformat header baru...');
                await sheet.setHeaderRow(expectedHeaders);

                await sheet.loadCells('A1:F1');
                for (let i = 0; i < expectedHeaders.length; i++) {
                    const cell = sheet.getCell(0, i);
                    cell.textFormat = { bold: true };
                    cell.horizontalAlignment = 'CENTER';
                    cell.backgroundColor = headerColorsSheet1[i]; // Menggunakan headerColorsSheet1
                }
                await sheet.saveUpdatedCells();
            } else {
                throw error;
            }
        }

        const rows = await sheet.getRows();
        const nextRowNumber = rows.length + 1;

        await sheet.addRow({
            'No': nextRowNumber,
            'Tanggal': data.date,
            'Relay': data.channel,
            'Durasi (Menit)': data.duration,
            'Waktu Pakai': data.usageTime,
            'Total Harga': data.totalPrice
        });

        const newRowA1Index = nextRowNumber + 1;

        const newRowColor = (nextRowNumber % 2 === 0) ? rowColorEven : rowColorOdd;

        await sheet.loadCells(`A${newRowA1Index}:F${newRowA1Index}`);
        for (let i = 0; i < expectedHeaders.length; i++) {
            const cell = sheet.getCell(newRowA1Index - 1, i);
            cell.horizontalAlignment = 'CENTER';
            cell.backgroundColor = newRowColor;
        }
        await sheet.saveUpdatedCells();

        logActivity(`SHEETS: Data untuk Relay ${data.channel} berhasil ditambahkan dan diformat di ${SHEET1_NAME}.`);
    } catch (error) {
        logActivity(`SHEETS ERROR (appendToSheet): Gagal memproses Google Sheet. Error: ${error.message}`);
        console.error(error);
    }
}

/**
 * Mendapatkan objek sheet dari Google Spreadsheet berdasarkan nama.
 * Jika sheet tidak ditemukan, sheet baru akan dibuat.
 * @param {string} sheetName Nama sheet yang akan dicari atau dibuat.
 * @param {GoogleSpreadsheet} doc Objek GoogleSpreadsheet yang sudah terautentikasi.
 * @returns {GoogleSpreadsheetWorksheet} Objek worksheet.
 */
async function getOrCreateSheet(sheetName, doc) {
    try {
        let sheet = doc.sheetsByTitle[sheetName];
        if (!sheet) {
            logActivity(`SHEETS: Sheet '${sheetName}' tidak ditemukan, mencoba membuat sheet baru.`);
            sheet = await doc.addSheet({ title: sheetName });
            logActivity(`SHEETS: Sheet '${sheetName}' berhasil dibuat.`);
        } else {
            logActivity(`SHEETS: Sheet '${sheetName}' sudah ada.`);
        }
        return sheet;
    } catch (error) {
        logActivity(`SHEETS ERROR (getOrCreateSheet): Gagal mendapatkan atau membuat sheet '${sheetName}'. Error: ${error.message}`);
        throw error;
    }
}

/**
 * Mengambil data dari Sheet1, menghitung rekap penggunaan relay per bulan,
 * dan menulis hasilnya ke Sheet2.
 * Rekap mencakup frekuensi penggunaan, total durasi (jam:menit),
 * keuntungan per relay, dan total keuntungan bulanan.
 * @param {number} chatIdForError ID chat Telegram untuk mengirim pesan error.
 */
async function generateMonthlyRecap(chatIdForError) { // Tambahkan parameter untuk chatId
    logActivity('RECAP: Memulai pembuatan rekap bulanan...');
    try {
        await doc.loadInfo();
        const sheet1 = doc.sheetsByTitle[SHEET1_NAME];
        if (!sheet1) {
            const errorMessage = `RECAP ERROR: Sheet dengan nama '${SHEET1_NAME}' tidak ditemukan. Tidak dapat membuat rekap. Pastikan nama sheet di Google Sheets adalah '${SHEET1_NAME}' dan akun layanan memiliki izin 'Editor'.`;
            logActivity(errorMessage);
            if (chatIdForError) bot.sendMessage(chatIdForError, errorMessage);
            return;
        }
        logActivity(`RECAP: Berhasil mengakses Sheet1 (${SHEET1_NAME}).`);

        const rows = await sheet1.getRows();
        logActivity(`RECAP: Berhasil membaca ${rows.length} baris dari Sheet1.`);

        const monthlyData = {};

        rows.forEach(row => {
            // Menggunakan _rawData untuk akses data yang lebih langsung dan menghindari masalah pemetaan header.
            // Pastikan row._rawData ada dan memiliki cukup elemen (setidaknya 6 kolom).
            if (!row._rawData || row._rawData.length < 6) {
                logActivity(`RECAP WARNING: Baris dilewati karena format data tidak lengkap: ${JSON.stringify(row._rawData)}`);
                return;
            }

            // Ambil data menggunakan indeks kolom dari _rawData
            const dateStr = row._rawData[1]; // Tanggal ada di indeks 1
            const relay = row._rawData[2]; // Relay ada di indeks 2
            const duration = parseInt(row._rawData[3], 10); // Durasi ada di indeks 3
            const totalPriceStr = row._rawData[5]; // Total Harga ada di indeks 5

            if (!dateStr || dateStr.trim() === '') { // Tambahkan .trim() untuk mengecek spasi kosong
                logActivity(`RECAP WARNING: Baris dilewati karena tanggal kosong: ${JSON.stringify(row._rawData)}`);
                return;
            }

            const [day, month, year] = dateStr.split('/');
            const monthYear = `${year}-${month.padStart(2, '0')}`;

            if (!monthlyData[monthYear]) {
                monthlyData[monthYear] = { totalMonthlyProfit: 0 };
                for (let i = 1; i <= 8; i++) {
                    monthlyData[monthYear][`relay${i}`] = { count: 0, totalDuration: 0, totalProfit: 0 };
                }
            }

            // Bersihkan string harga sebelum mengkonversi ke float
            const totalPrice = parseFloat(totalPriceStr.replace(/[^0-9,-]+/g, "").replace(",", ".")) || 0;

            if (relay && !isNaN(duration) && !isNaN(totalPrice)) {
                const relayKey = `relay${relay}`;
                if (monthlyData[monthYear][relayKey]) {
                    monthlyData[monthYear][relayKey].count++;
                    monthlyData[monthYear][relayKey].totalDuration += duration;
                    monthlyData[monthYear][relayKey].totalProfit += totalPrice;
                    monthlyData[monthYear].totalMonthlyProfit += totalPrice;
                } else {
                    logActivity(`RECAP WARNING: Data relay '${relay}' tidak valid atau tidak terinisialisasi untuk bulan ${monthYear} di baris: ${JSON.stringify(row._rawData)}`);
                }
            } else {
                logActivity(`RECAP WARNING: Data tidak lengkap (duration/totalPrice invalid) untuk baris: ${JSON.stringify(row._rawData)}`);
            }
        });

        // Debugging log ini dapat dihapus setelah yakin data terkumpul dengan benar
        // logActivity(`RECAP: Data bulanan yang terkumpul: ${JSON.stringify(monthlyData, null, 2)}`);

        const sheet2 = await getOrCreateSheet(SHEET2_NAME, doc);
        logActivity(`RECAP: Berhasil mengakses Sheet2 (${SHEET2_NAME}).`);

        const headerRow = ['Bulan'];
        for (let i = 1; i <= 8; i++) {
            headerRow.push(`Relay ${i} (Kali)`);
            headerRow.push(`Relay ${i} (Jam:Menit)`);
            headerRow.push(`Keuntungan Relay ${i}`);
        }
        headerRow.push('Total Keuntungan Bulanan');

        await sheet2.setHeaderRow(headerRow);
        logActivity('RECAP: Header Sheet2 berhasil diatur.');

        // Warna latar belakang untuk header Sheet2 (opsional, bisa disesuaikan)
        const sheet2HeaderColors = [
            { red: 0.85, green: 0.85, blue: 0.85 },
            { red: 0.76, green: 0.87, blue: 0.98 }, { red: 0.76, green: 0.87, blue: 0.98 }, { red: 0.76, green: 0.87, blue: 0.98 },
            { red: 0.98, green: 0.85, blue: 0.76 }, { red: 0.98, green: 0.85, blue: 0.76 }, { red: 0.98, green: 0.85, blue: 0.76 },
            { red: 1.00, green: 0.95, blue: 0.76 }, { red: 1.00, green: 0.95, blue: 0.76 }, { red: 1.00, green: 0.95, blue: 0.76 },
            { red: 0.82, green: 0.93, blue: 0.82 }, { red: 0.82, green: 0.93, blue: 0.82 }, { red: 0.82, green: 0.93, blue: 0.82 },
            { red: 0.98, green: 0.79, blue: 0.81 }, { red: 0.98, green: 0.79, blue: 0.81 }, { red: 0.98, green: 0.79, blue: 0.81 },
            { red: 0.76, green: 0.87, blue: 0.98 }, { red: 0.76, green: 0.87, blue: 0.98 }, { red: 0.76, green: 0.87, blue: 0.98 },
            { red: 0.98, green: 0.85, blue: 0.76 }, { red: 0.98, green: 0.85, blue: 0.76 }, { red: 0.98, green: 0.85, blue: 0.76 },
            { red: 1.00, green: 0.95, blue: 0.76 }, { red: 1.00, green: 0.95, blue: 0.76 }, { red: 1.00, green: 1.00, blue: 0.76 },
            { red: 0.85, green: 0.85, blue: 0.85 }
        ];

        await sheet2.loadCells(`A1:${String.fromCharCode(65 + headerRow.length - 1)}1`);
        for (let i = 0; i < headerRow.length; i++) {
            const cell = sheet2.getCell(0, i);
            cell.textFormat = { bold: true };
            cell.horizontalAlignment = 'CENTER';
            if (sheet2HeaderColors[i]) {
                cell.backgroundColor = sheet2HeaderColors[i];
            }
        }
        await sheet2.saveUpdatedCells();

        const sortedMonthYears = Object.keys(monthlyData).sort();
        const recapRows = [];
        for (const monthYear of sortedMonthYears) {
            const rowData = [monthYear];

            for (let i = 1; i <= 8; i++) {
                const relayKey = `relay${i}`;
                const relayData = monthlyData[monthYear][relayKey];

                if (relayData) {
                    const totalHours = Math.floor(relayData.totalDuration / 60);
                    const remainingMinutes = relayData.totalDuration % 60;
                    const formattedDuration = `${totalHours}:${String(remainingMinutes).padStart(2, '0')}`;

                    rowData.push(relayData.count);
                    rowData.push(formattedDuration);
                    rowData.push(new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(relayData.totalProfit));
                } else {
                    rowData.push(0);
                    rowData.push('0:00');
                    rowData.push(new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(0));
                }
            }
            rowData.push(new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(monthlyData[monthYear].totalMonthlyProfit));
            recapRows.push(rowData);
        }

        await sheet2.clearRows();
        logActivity('RECAP: Sheet2 telah dikosongkan.');

        if (recapRows.length > 0) {
            await sheet2.addRows(recapRows);
            logActivity(`RECAP: ${recapRows.length} baris rekap ditambahkan ke Sheet2.`);

            await sheet2.loadCells(`A2:${String.fromCharCode(65 + headerRow.length - 1)}${recapRows.length + 1}`);
            for (let r = 0; r < recapRows.length; r++) {
                const newRowColor = (r % 2 === 0) ? rowColorEven : rowColorOdd;
                for (let c = 0; c < headerRow.length; c++) {
                    const cell = sheet2.getCell(r + 1, c);
                    cell.horizontalAlignment = 'CENTER';
                    cell.backgroundColor = newRowColor;
                }
            }
            await sheet2.saveUpdatedCells();
            logActivity('RECAP: Zebra striping diterapkan pada Sheet2.');
        } else {
            logActivity('RECAP: Tidak ada data rekap untuk ditambahkan ke Sheet2 (Sheet1 mungkin kosong atau tidak ada data yang valid).');
        }

        logActivity('RECAP: Rekap bulanan berhasil diperbarui di Sheet2.');
    } catch (error) {
        const errorMessage = `RECAP ERROR (generateMonthlyRecap): Gagal membuat rekap bulanan. Error: ${error.message}`;
        logActivity(errorMessage);
        console.error(error);
        if (chatIdForError) bot.sendMessage(chatIdForError, `Terjadi kesalahan saat membuat rekap. Mohon periksa log server untuk detail: ${error.message}`);
    }
}

// --- BOT COMMANDS & HANDLERS ---
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    logActivity(`CMD: /start diterima dari user ${msg.from.first_name} (ID: ${chatId})`);
    bot.sendMessage(chatId, "Kontrol Relay 8 Channel", {
        reply_markup: {
            inline_keyboard: generateRelayButtons()
        }
    });
});

bot.onText(/\/rekap/, async (msg) => {
    const chatId = msg.chat.id;
    logActivity(`CMD: /rekap diterima dari user ${msg.from.first_name} (ID: ${chatId})`);
    bot.sendMessage(chatId, "Memproses rekap data bulanan... Mohon tunggu.");
    await generateMonthlyRecap(chatId);
    bot.sendMessage(chatId, "Rekap data bulanan telah selesai. Anda dapat melihatnya di Google Sheet Anda: https://ungu.in/rentalku");
});

bot.onText(/\/sisawaktu/, (msg) => {
    const chatId = msg.chat.id;
    logActivity(`CMD: /sisawaktu diterima dari user ${msg.from.first_name} (ID: ${chatId})`);
    let statusMessage = "--- STATUS RELAY & TIMER ---\n\n";
    const now = Date.now();
    for (let i = 1; i <= 8; i++) {
        const channel = i.toString();
        const statusIcon = relayStatus[channel] === 'on' ? '🟢' : '🔴';
        const statusText = relayStatus[channel].toUpperCase();
        let timerInfo = "";
        if (relayTimerEndTimes[channel] && relayTimerEndTimes[channel] > now) {
            const remainingMs = relayTimerEndTimes[channel] - now;
            const minutes = Math.floor(remainingMs / (60 * 1000));
            const seconds = Math.floor((remainingMs % (60 * 1000)) / 1000);
            timerInfo = ` - Sisa waktu: ${minutes} menit ${seconds} detik`;
        }
        statusMessage += `${statusIcon} Relay ${channel}: ${statusText}${timerInfo}\n`;
    }
    bot.sendMessage(chatId, statusMessage);
});

bot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const user = callbackQuery.from.first_name;

    const relayMatch = data.match(/relay_(\d)_(on|off)/);
    if (relayMatch) {
        const channel = relayMatch[1];
        const action = relayMatch[2];
        if (relayStatus[channel] !== undefined) {
            logActivity(`AKSI: User ${user} mengubah Relay ${channel} menjadi ${action.toUpperCase()}`);
            relayStatus[channel] = action;
            bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Relay ${channel} di-set ${action}` });
            if (action === "off" && relayTimers[channel]) {
                logActivity(`TIMER: Timer untuk Relay ${channel} dibatalkan secara manual oleh ${user}.`);
                clearTimeout(relayTimers[channel]);
                delete relayTimers[channel];
                delete relayTimerEndTimes[channel];
                delete relayUsageData[channel];
            }
            bot.editMessageReplyMarkup({ inline_keyboard: generateRelayButtons() }, { chat_id: msg.chat.id, message_id: msg.message_id }).catch(err => { if (!err.message.includes("message is not modified")) { console.log("Error:", err.message); } });
        }
    }

    const timerMatch = data.match(/set_timer_(\d+)/);
    if (timerMatch) {
        const channel = timerMatch[1];
        logActivity(`AKSI: User ${user} ingin mengatur timer untuk Relay ${channel}.`);
        if (relayTimerEndTimes[channel] && relayTimerEndTimes[channel] > Date.now()) {
            bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Relay ${channel} sudah memiliki timer aktif.`, show_alert: true });
            return;
        }
        bot.sendMessage(msg.chat.id, `Masukkan waktu dalam menit untuk mematikan Relay ${channel}:`);
        bot.once('message', (msgInput) => {
            if (msgInput.chat.id !== msg.chat.id) return;
            const userInput = msgInput.text;
            if (userInput && !isNaN(userInput)) {
                const timerMinutes = parseInt(userInput, 10);
                if (timerMinutes > 0) {
                    logActivity(`TIMER: Timer ${timerMinutes} menit di-set untuk Relay ${channel} oleh ${user}.`);
                    bot.sendMessage(msg.chat.id, `✅ Timer di-set. Relay ${channel} akan mati setelah ${timerMinutes} menit.`);
                    startRelayTimer(channel, timerMinutes, msg.chat.id, msg.message_id);
                } else {
                    bot.sendMessage(msg.chat.id, `❌ Waktu tidak valid.`);
                }
            } else {
                bot.sendMessage(msg.chat.id, `❌ Input tidak valid. Mohon masukkan angka.`);
            }
        });
    }
});

function generateRelayButtons() {
    let buttons = [];
    for (let i = 1; i <= 8; i++) {
        buttons.push([
            { text: `Relay ${i} ON`, callback_data: `relay_${i}_on` },
            { text: `Relay ${i} OFF`, callback_data: `relay_${i}_off` }
        ]);
        if (relayStatus[i] === "on") {
            buttons.push([{ text: `Set Timer Relay ${i}`, callback_data: `set_timer_${i}` }]);
        }
    }
    return buttons;
}

function startRelayTimer(channel, minutes, chatId, messageId) {
    const startTime = new Date();
    const delay = minutes * 60 * 1000;
    const endTime = new Date(startTime.getTime() + delay);

    relayTimerEndTimes[channel] = endTime.getTime();
    relayMessageIds[channel] = { chatId, messageId };
    relayUsageData[channel] = { startTime, duration: minutes };

    relayTimers[channel] = setTimeout(() => {
        logActivity(`TIMER: Waktu untuk Relay ${channel} telah habis. Relay dimatikan.`);
        relayStatus[channel] = "off";
        bot.sendMessage(chatId, `⏰ Waktu habis! Relay ${channel} sekarang OFF.`);

        const usage = relayUsageData[channel];
        const priceForChannel = RELAY_PRICES[channel] || 0;
        let totalPrice = (usage.duration / 30) * priceForChannel;
        totalPrice = Math.round(totalPrice / 500) * 500; // bulatkan ke kelipatan 500

        const formatTime = (date) => date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

        const sheetData = {
            date: usage.startTime.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jakarta' }),
            channel: channel,
            duration: usage.duration,
            usageTime: `${formatTime(usage.startTime)} - ${formatTime(endTime)}`,
            totalPrice: new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(totalPrice)
        };

        appendToSheet(sheetData);

        delete relayTimers[channel];
        delete relayTimerEndTimes[channel];
        delete relayUsageData[channel];

        bot.editMessageReplyMarkup({ inline_keyboard: generateRelayButtons() }, { chat_id: relayMessageIds[channel].chatId, message_id: relayMessageIds[channel].messageId }).catch(err => {
            if (!err.message.includes("message is not modified")) {
                console.log("Error updating message reply markup:", err.message);
            }
        });
    }, delay);
}

// --- EXPRESS SERVER ---
app.get('/status', (req, res) => {
    logActivity(`DEVICE: Permintaan status diterima dari ${req.ip}`);
    res.json(relayStatus);
});

app.listen(3000, () => {
    logActivity('SERVER: Server berhasil dijalankan di port 3000.');
});
