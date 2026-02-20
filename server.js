require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const https = require('https');
const { OAuth2Client } = require('google-auth-library');

// ─── AI HELPER — Gemini 2.0 Flash (primary) + OpenRouter (fallback) ─────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyAF29JUbKPg6kfr-ZdaMxXpsnIU-1yRQ4c';

function geminiRequest(systemPrompt, userMessages, maxTokens) {
  return new Promise((resolve, reject) => {
    // Build URL fresh each call so env var changes take effect
    const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY;
    // Build Gemini contents array from history
    const contents = [];
    for (const m of userMessages) {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    }
    const body = JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens || 1024, temperature: 0.7 }
    });
    const urlObj = new URL(GEMINI_URL);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { reject(new Error(parsed.error.message || JSON.stringify(parsed.error))); return; }
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch (e) { reject(new Error('Gemini JSON parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

function openRouterRequest(body) {
  const OR_KEY = process.env.OPENROUTER_KEY || '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';
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OR_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://solve-q7hx.onrender.com',
        'X-Title': 'PlacementPro',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('OpenRouter JSON error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenRouter timeout')); });
    req.write(payload);
    req.end();
  });
}

async function askAI(systemPrompt, messages) {
  // 1️⃣ Try Gemini first
  try {
    console.log("🤖 Trying Gemini...");
    const geminiReply = await geminiRequest(systemPrompt, messages, 1024);
    if (geminiReply && geminiReply.trim()) {
      console.log("✅ Gemini success");
      return geminiReply;
    }
    throw new Error("Empty Gemini response");
  } catch (err) {
    console.error("❌ Gemini failed:", err.message);
  }

  // 2️⃣ Fallback to OpenRouter
  try {
    console.log("🔁 Falling back to OpenRouter...");
    const orResp = await openRouterRequest({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages
      ],
      max_tokens: 800,
      temperature: 0.7
    });

    const text = orResp?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty OpenRouter response");

    console.log("✅ OpenRouter success");
    return text;
  } catch (err) {
    console.error("❌ OpenRouter failed:", err.message);
    throw new Error("Both Gemini and OpenRouter failed");
  }
}

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://pra:pra@pra.si69pt4.mongodb.net/placementpro?appName=pra';

// ─── MONGODB CONNECTION ──────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// ─── MODELS ──────────────────────────────────────────────────────────────────
const Student = mongoose.model('Student', new mongoose.Schema({
  name: { type: String, required: true },
  usn: { type: String, required: true, unique: true },
  branch: { type: String, required: true },
  year: { type: Number, required: true },
  cgpa: { type: Number, required: true },
  backlogs: { type: Number, default: 0 },
  email: String,
  phone: String,
  interestedCompanies: [String],
  assessmentScores: [{ assessmentId: mongoose.Schema.Types.ObjectId, score: Number, maxScore: Number, submittedAt: Date }],
  driveApplications: [{ driveId: mongoose.Schema.Types.ObjectId, status: { type: String, enum: ['eligible', 'applied', 'shortlisted', 'selected', 'rejected'], default: 'eligible' }, ranking: { type: String, enum: ['Best', 'Better', 'Average'] } }],
  password: { type: String, default: 'student123' },
  // Extended profile from Google Form
  profile: {
    gender: String,
    personalEmail: String,
    collegeEmail: String,
    marks10th: String,
    board10th: String,
    marks12th: String,
    board12th: String,
    diplomaPct: String,
    diplomaBoard: String,
    ongoingBacklogs: Number,
    historyBacklogs: Number,
    presentAddress: String,
    permanentAddress: String,
    aadharNo: String
  },
  createdAt: { type: Date, default: Date.now }
}));

const Drive = mongoose.model('Drive', new mongoose.Schema({
  companyName: { type: String, required: true },
  description: String,
  minCGPA: { type: Number, required: true },
  maxBacklogs: { type: Number, default: 0 },
  eligibleBranches: [String],
  eligibleYear: [Number],
  minAssessmentScore: { type: Number, default: 0 },
  driveDate: Date,
  deadline: Date,
  package: String,
  location: String,
  status: { type: String, enum: ['upcoming', 'active', 'completed'], default: 'upcoming' },
  eligibleCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

const Assessment = mongoose.model('Assessment', new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, default: 'Mixed' },
  categories: [String],
  subTopics: [String],
  driveId: mongoose.Schema.Types.ObjectId,
  questions: [{ question: String, options: [String], correctAnswer: Number, marks: { type: Number, default: 1 }, topic: String }],
  timeLimit: { type: Number, default: 30 },
  totalMarks: Number,
  isActive: { type: Boolean, default: false },
  aiGenerated: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}));

const AssignmentAttempt = mongoose.model('AssignmentAttempt', new mongoose.Schema({
  assessmentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  usn: { type: String, required: true },
  studentName: String,
  status: { type: String, enum: ['in-progress', 'submitted', 'malpractice'], default: 'in-progress' },
  startedAt: { type: Date, default: Date.now },
  submittedAt: Date,
  answers: mongoose.Schema.Types.Mixed,
  score: Number,
  maxScore: Number,
  tabSwitchCount: { type: Number, default: 0 },
  warnings: { type: Number, default: 0 },
  malpracticeLog: [{ event: String, timestamp: Date }],
  isMalpractice: { type: Boolean, default: false }
}));

const Notification = mongoose.model('Notification', new mongoose.Schema({
  studentId: mongoose.Schema.Types.ObjectId,
  usn: String,
  title: String,
  message: String,
  type: { type: String, enum: ['drive', 'assessment', 'shortlist', 'general'], default: 'general' },
  driveId: mongoose.Schema.Types.ObjectId,
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}));

// ─── INTERVIEW SLOT MODEL ─────────────────────────────────────────────────────
const InterviewSlot = mongoose.model('InterviewSlot', new mongoose.Schema({
  driveId: { type: mongoose.Schema.Types.ObjectId, required: true },
  driveName: { type: String, default: '' },
  studentId: mongoose.Schema.Types.ObjectId,
  studentName: { type: String, required: true },
  usn: { type: String, required: true },
  studentEmail: { type: String, default: '' },
  date: { type: Date, required: true },
  startTime: { type: String, required: true },   // "09:00"
  endTime: { type: String, required: true },   // "09:30"
  mode: { type: String, enum: ['online', 'offline', 'hybrid'], default: 'online' },
  location: { type: String, default: '' },
  notes: { type: String, default: '' },
  status: { type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled' },
  createdAt: { type: Date, default: Date.now }
}));

// ─── ALUMNI MODELS ───────────────────────────────────────────────────────────
const Alumni = mongoose.model('Alumni', new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  company: { type: String, default: '' },
  designation: { type: String, default: '' },
  linkedin: { type: String, default: '' },
  github: { type: String, default: '' },
  gmail: { type: String, default: '' },
  branch: { type: String, default: '' },
  gradYear: { type: Number, default: 0 },
  profileComplete: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}));

const AlumniGroup = mongoose.model('AlumniGroup', new mongoose.Schema({
  name: { type: String, required: true },
  companyTag: { type: String, required: true },
  createdBy: { type: String, required: true },
  creatorName: { type: String, required: true },
  creatorRole: { type: String, default: 'student' },
  members: [{
    userId: String,
    name: String,
    role: { type: String, enum: ['student', 'alumni', 'admin'], default: 'student' },
    joinedAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
}));

const GroupMessage = mongoose.model('GroupMessage', new mongoose.Schema({
  groupId: { type: mongoose.Schema.Types.ObjectId, required: true },
  section: { type: String, enum: ['general', 'resource'], default: 'general' },
  senderId: { type: String, required: true },
  senderName: { type: String, required: true },
  senderRole: { type: String, enum: ['student', 'alumni', 'admin'], default: 'student' },
  content: { type: String, default: '' },
  fileName: { type: String, default: '' },
  fileUrl: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
}));

const PrivateMessage = mongoose.model('PrivateMessage', new mongoose.Schema({
  groupId: { type: mongoose.Schema.Types.ObjectId, required: true },
  studentId: { type: String, required: true },
  alumniId: { type: String, required: true },
  senderId: { type: String, required: true },
  senderRole: { type: String, enum: ['student', 'alumni'], required: true },
  senderName: { type: String, required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'placementpro-secret', resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }));

const upload = multer({ dest: 'uploads/' });

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password, role } = req.body;
  if (role === 'admin') {
    if (username === 'a' && password === 'a') {
      req.session.user = { role: 'admin', username: 'a', name: 'TPO Admin' };
      return res.json({ success: true, role: 'admin' });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (role === 'student') {
    const student = await Student.findOne({ usn: username.toUpperCase() });
    if (!student) return res.status(401).json({ error: 'Student not found' });
    if (student.password !== password) return res.status(401).json({ error: 'Invalid password' });
    req.session.user = { role: 'student', username: student.usn, name: student.name, id: student._id };
    // Check if this is first login (profile not yet filled via Google Form)
    const profileComplete = (student.cgpa && student.cgpa > 0);
    return res.json({ success: true, role: 'student', name: student.name, usn: student.usn, needsProfile: !profileComplete });
  }
  res.status(400).json({ error: 'Invalid role' });
});

// Check if student profile has been filled (used for polling after Google Form redirect)
app.get('/api/auth/profile-status/:usn', async (req, res) => {
  try {
    const student = await Student.findOne({ usn: req.params.usn.toUpperCase() });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const profileComplete = (student.cgpa && student.cgpa > 0);
    res.json({ profileComplete, name: student.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential, name: submittedName } = req.body;

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email;

    // Use the name the user confirmed in the modal (fallback to Google's name)
    const name = (submittedName || payload.name || '').trim();

    // 🔒 Allow only vvce.ac.in emails
    if (!email.endsWith('@vvce.ac.in')) {
      return res.json({ success: false, error: 'Only @vvce.ac.in emails are allowed' });
    }

    if (!name) {
      return res.json({ success: false, error: 'Name is required' });
    }

    // Derive USN from email prefix (e.g. 1ms21cs001@vvce.ac.in → 1MS21CS001)
    const usn = email.split('@')[0].toUpperCase();

    // Upsert: create student if new, update name if already exists
    let student = await Student.findOneAndUpdate(
      { $or: [{ email }, { usn }] },
      {
        $set: { name, email, password: 'google-auth' },
        $setOnInsert: { usn, branch: 'CSE', year: 4, cgpa: 0, backlogs: 0 }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Save session — username field matches normal student login
    req.session.user = {
      role: 'student',
      username: student.usn,
      id: student._id,
      email,
      name: student.name
    };

    const profileComplete = (student.cgpa && student.cgpa > 0);
    res.json({ success: true, role: 'student', name: student.name, usn: student.usn, needsProfile: !profileComplete });

  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Google login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/auth/me', (req, res) => { if (req.session.user) return res.json(req.session.user); res.status(401).json({ error: 'Not authenticated' }); });

// ─── STUDENT ROUTES ──────────────────────────────────────────────────────────
app.get('/api/students', async (req, res) => {
  try { res.json(await Student.find({}, '-password')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/students', async (req, res) => {
  try { const s = await new Student(req.body).save(); res.json({ success: true, student: s }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/students/:id', async (req, res) => {
  try { res.json(await Student.findByIdAndUpdate(req.params.id, req.body, { new: true })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/students/:id', async (req, res) => {
  try { await Student.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/students/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const results = [];
  fs.createReadStream(req.file.path).pipe(csv()).on('data', d => {
    results.push({ name: d.Name || d.name, usn: (d.USN || d.usn || '').toUpperCase(), branch: d.Branch || d.branch, year: parseInt(d.Year || d.year) || 4, cgpa: parseFloat(d.CGPA || d.cgpa) || 0, backlogs: parseInt(d.Backlogs || d.backlogs) || 0, email: d.Email || d.email || '', phone: d.Phone || d.phone || '', password: 'student123' });
  }).on('end', async () => {
    try {
      let added = 0, skipped = 0;
      for (const s of results) {
        if (!s.usn || !s.name) { skipped++; continue; }
        await Student.findOneAndUpdate({ usn: s.usn }, { $set: s }, { upsert: true, new: true });
        added++;
      }
      fs.unlinkSync(req.file.path);
      res.json({ success: true, added, skipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

app.post('/api/students/eligible', async (req, res) => {
  try {
    const { minCGPA, maxBacklogs, eligibleBranches, eligibleYear } = req.body;
    const q = { cgpa: { $gte: minCGPA || 0 }, backlogs: { $lte: maxBacklogs !== undefined ? maxBacklogs : 99 } };
    if (eligibleBranches?.length > 0) q.branch = { $in: eligibleBranches };
    if (eligibleYear?.length > 0) q.year = { $in: eligibleYear };
    const students = await Student.find(q, '-password');
    res.json({ count: students.length, students });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/students/me/:usn', async (req, res) => {
  try { res.json(await Student.findOne({ usn: req.params.usn }, '-password')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DRIVE ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/drives', async (req, res) => {
  try { res.json(await Drive.find().sort({ createdAt: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drives', async (req, res) => {
  try {
    const { minCGPA, maxBacklogs, eligibleBranches, eligibleYear } = req.body;
    const q = { cgpa: { $gte: minCGPA || 0 }, backlogs: { $lte: maxBacklogs !== undefined ? maxBacklogs : 99 } };
    if (eligibleBranches?.length > 0) q.branch = { $in: eligibleBranches };
    if (eligibleYear?.length > 0) q.year = { $in: eligibleYear };
    const eligibleCount = await Student.countDocuments(q);
    const drive = await new Drive({ ...req.body, eligibleCount }).save();
    res.json({ success: true, drive, eligibleCount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/drives/:id', async (req, res) => {
  try { res.json(await Drive.findByIdAndUpdate(req.params.id, req.body, { new: true })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/drives/:id', async (req, res) => {
  try { await Drive.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/drives/:id/notify', async (req, res) => {
  try {
    const drive = await Drive.findById(req.params.id);
    if (!drive) return res.status(404).json({ error: 'Drive not found' });
    const q = { cgpa: { $gte: drive.minCGPA }, backlogs: { $lte: drive.maxBacklogs } };
    if (drive.eligibleBranches?.length > 0) q.branch = { $in: drive.eligibleBranches };
    if (drive.eligibleYear?.length > 0) q.year = { $in: drive.eligibleYear };
    const students = await Student.find(q);
    await Notification.insertMany(students.map(s => ({ studentId: s._id, usn: s.usn, title: `New Drive: ${drive.companyName}`, message: `You are eligible for ${drive.companyName}! Min CGPA: ${drive.minCGPA}, Package: ${drive.package || 'TBD'}. Check it out!`, type: 'drive', driveId: drive._id })));
    for (const s of students) {
      if (!s.driveApplications.find(d => d.driveId.toString() === drive._id.toString())) {
        s.driveApplications.push({ driveId: drive._id, status: 'eligible' });
        await s.save();
      }
    }
    res.json({ success: true, notified: students.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drives/:id/shortlist', async (req, res) => {
  try {
    const drive = await Drive.findById(req.params.id);
    const q = { cgpa: { $gte: drive.minCGPA }, backlogs: { $lte: drive.maxBacklogs } };
    if (drive.eligibleBranches?.length > 0) q.branch = { $in: drive.eligibleBranches };
    if (drive.eligibleYear?.length > 0) q.year = { $in: drive.eligibleYear };
    const students = await Student.find(q);
    const ranked = students.map(s => {
      let score = s.cgpa * 10;
      const aScore = s.assessmentScores.find(a => a.maxScore > 0);
      if (aScore) score += (aScore.score / aScore.maxScore) * 30;
      return { student: s, score, ranking: score >= 90 ? 'Best' : score >= 70 ? 'Better' : 'Average' };
    });
    for (const r of ranked) {
      await Student.findOneAndUpdate({ _id: r.student._id, 'driveApplications.driveId': drive._id }, { $set: { 'driveApplications.$.ranking': r.ranking, 'driveApplications.$.status': 'shortlisted' } });
      await Notification.create({ studentId: r.student._id, usn: r.student.usn, title: `Shortlisted: ${drive.companyName}`, message: `You've been shortlisted for ${drive.companyName}! Ranking: ${r.ranking}`, type: 'shortlist', driveId: drive._id });
    }
    res.json({ success: true, shortlisted: ranked.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/drives/student/:usn', async (req, res) => {
  try {
    const student = await Student.findOne({ usn: req.params.usn });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const drives = await Drive.find({ status: { $in: ['upcoming', 'active'] } });
    res.json(drives.filter(d =>
      student.cgpa >= d.minCGPA &&
      student.backlogs <= d.maxBacklogs &&
      (d.eligibleBranches.length === 0 || d.eligibleBranches.includes(student.branch)) &&
      (d.eligibleYear.length === 0 || d.eligibleYear.includes(student.year))
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All drives (active + upcoming + completed) with eligibility flag per student
app.get('/api/drives/student/:usn/all', async (req, res) => {
  try {
    const student = await Student.findOne({ usn: req.params.usn });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const drives = await Drive.find({}).sort({ driveDate: -1 });
    const result = drives.map(d => {
      const reasons = [];
      if (student.cgpa < d.minCGPA) reasons.push(`CGPA ${student.cgpa} < required ${d.minCGPA}`);
      if (student.backlogs > d.maxBacklogs) reasons.push(`${student.backlogs} backlog(s) exceed limit of ${d.maxBacklogs}`);
      if (d.eligibleBranches.length > 0 && !d.eligibleBranches.includes(student.branch))
        reasons.push(`Branch ${student.branch} not eligible (${d.eligibleBranches.join(', ')})`);
      if (d.eligibleYear.length > 0 && !d.eligibleYear.includes(student.year))
        reasons.push(`Year ${student.year} not in eligible years`);
      return { ...d.toObject(), isEligible: reasons.length === 0, ineligibleReasons: reasons };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI QUIZ GENERATION ───────────────────────────────────────────────────────
app.post('/api/quiz/generate', async (req, res) => {
  try {
    const { categories, subTopics, questionCount = 10, difficulty = 'mixed' } = req.body;
    if (!categories || !categories.length) return res.status(400).json({ error: 'Categories required' });

    // ── LARGE QUESTION BANK ──────────────────────────────────────────────────
    const BANK = {
      Aptitude: [
        { question: "If a train travels 360 km in 4 hours, what is its speed in m/s?", options: ["25 m/s", "50 m/s", "90 m/s", "100 m/s"], correctAnswer: 0, topic: "Speed & Distance" },
        { question: "A can do a work in 15 days, B in 20 days. Together they finish in?", options: ["8 days", "8.57 days", "9 days", "10 days"], correctAnswer: 1, topic: "Time & Work" },
        { question: "What is 15% of 480?", options: ["62", "68", "72", "76"], correctAnswer: 2, topic: "Percentages" },
        { question: "If 6 men can do a job in 10 days, how many men are needed to do it in 5 days?", options: ["10", "12", "14", "16"], correctAnswer: 1, topic: "Time & Work" },
        { question: "A sum doubles in 10 years at simple interest. Rate of interest per annum?", options: ["8%", "10%", "12%", "15%"], correctAnswer: 1, topic: "Simple Interest" },
        { question: "Find the next number: 2, 6, 12, 20, 30, ?", options: ["40", "42", "44", "46"], correctAnswer: 1, topic: "Number Series" },
        { question: "Find the odd one out: 2, 3, 5, 7, 9, 11", options: ["2", "9", "3", "5"], correctAnswer: 1, topic: "Odd One Out" },
        { question: "What is the LCM of 12 and 18?", options: ["24", "36", "48", "72"], correctAnswer: 1, topic: "LCM & HCF" },
        { question: "A shopkeeper sells a product at 20% profit. If CP is ₹500, what is SP?", options: ["₹580", "₹600", "₹620", "₹640"], correctAnswer: 1, topic: "Profit & Loss" },
        { question: "If ABCD = 1234, then DCBA = ?", options: ["4321", "3241", "4312", "3421"], correctAnswer: 0, topic: "Coding" },
        { question: "Average of first 10 natural numbers?", options: ["5", "5.5", "6", "6.5"], correctAnswer: 1, topic: "Averages" },
        { question: "A pipe fills a tank in 4 hrs, another drains it in 8 hrs. Together?", options: ["6 hrs", "7 hrs", "8 hrs", "10 hrs"], correctAnswer: 2, topic: "Pipes & Cisterns" },
        { question: "Ratio of 3:4 means if one part is 75, other is?", options: ["90", "100", "112", "125"], correctAnswer: 1, topic: "Ratio & Proportion" },
        { question: "Which is the smallest prime number?", options: ["0", "1", "2", "3"], correctAnswer: 2, topic: "Number Theory" },
        { question: "Find the missing: 1, 4, 9, 16, ?, 36", options: ["20", "25", "28", "30"], correctAnswer: 1, topic: "Number Series" },
        { question: "If 40% of a number is 120, the number is?", options: ["250", "300", "350", "400"], correctAnswer: 1, topic: "Percentages" },
        { question: "Speed of boat in still water is 10 km/h, stream speed 2 km/h. Upstream speed?", options: ["6", "8", "10", "12"], correctAnswer: 1, topic: "Boats & Streams" },
        { question: "How many ways to arrange letters in 'DOG'?", options: ["3", "4", "6", "8"], correctAnswer: 2, topic: "Permutations" },
        { question: "Compound interest on ₹1000 at 10% for 2 years?", options: ["₹200", "₹205", "₹210", "₹215"], correctAnswer: 2, topic: "Compound Interest" },
        { question: "If today is Monday, what day is 100 days later?", options: ["Wednesday", "Thursday", "Friday", "Saturday"], correctAnswer: 1, topic: "Calendar" }
      ],
      "Logical Reasoning": [
        { question: "All cats are animals. Some animals are dogs. Which is definitely true?", options: ["Some cats are dogs", "All animals are cats", "Some cats may not be animals", "All dogs are animals"], correctAnswer: 3, topic: "Syllogisms" },
        { question: "DOCTOR : HOSPITAL :: TEACHER : ?", options: ["BOOK", "SCHOOL", "STUDENT", "DESK"], correctAnswer: 1, topic: "Analogies" },
        { question: "If A > B, B > C, then?", options: ["C > A", "A > C", "A = C", "C > B"], correctAnswer: 1, topic: "Inequalities" },
        { question: "Find the odd one out: Apple, Mango, Carrot, Orange", options: ["Apple", "Mango", "Carrot", "Orange"], correctAnswer: 2, topic: "Classification" },
        { question: "A is B's brother. B is C's mother. How is A related to C?", options: ["Father", "Uncle", "Grandfather", "Brother"], correctAnswer: 1, topic: "Blood Relations" },
        { question: "Point A is 5km North of B. C is 3km East of B. A is ? of C.", options: ["North-East", "North-West", "South-East", "South-West"], correctAnswer: 1, topic: "Direction Sense" },
        { question: "6th from left is 14th from right in a row. Total students?", options: ["18", "19", "20", "21"], correctAnswer: 1, topic: "Ordering" },
        { question: "If FIRE = 6935, CODE = ?", options: ["3145", "3154", "1345", "5314"], correctAnswer: 0, topic: "Coding-Decoding" },
        { question: "Mirror image of 'p' is?", options: ["b", "d", "q", "p"], correctAnswer: 1, topic: "Mirror Images" },
        { question: "Statement: All pens are books. Conclusion: Some books are pens.", options: ["True", "False", "Uncertain", "Partly true"], correctAnswer: 0, topic: "Syllogisms" },
        { question: "Which figure completes the series: Circle, Square, Triangle, Circle, Square, ?", options: ["Circle", "Square", "Triangle", "Pentagon"], correctAnswer: 2, topic: "Pattern" },
        { question: "If 5 * 3 = 28 and 6 * 2 = 32, then 7 * 4 = ?", options: ["44", "45", "46", "47"], correctAnswer: 0, topic: "Mathematical Puzzles" }
      ],
      Technical: [
        { question: "What is the time complexity of binary search?", options: ["O(n)", "O(log n)", "O(n²)", "O(1)"], correctAnswer: 1, topic: "Algorithms" },
        { question: "Which data structure uses LIFO principle?", options: ["Queue", "Stack", "Array", "Linked List"], correctAnswer: 1, topic: "Data Structures" },
        { question: "What does SQL stand for?", options: ["Structured Query Language", "Simple Query Language", "Standard Query Language", "Sequential Query Language"], correctAnswer: 0, topic: "SQL" },
        { question: "Which OOP concept allows a class to inherit from multiple classes?", options: ["Encapsulation", "Multiple Inheritance", "Polymorphism", "Abstraction"], correctAnswer: 1, topic: "OOP" },
        { question: "What is a primary key in a database?", options: ["A key that can be NULL", "A unique identifier for each record", "A foreign key reference", "An index key"], correctAnswer: 1, topic: "DBMS" },
        { question: "Which sorting algorithm has O(n log n) average time complexity?", options: ["Bubble Sort", "Selection Sort", "Merge Sort", "Insertion Sort"], correctAnswer: 2, topic: "Algorithms" },
        { question: "What does HTTP stand for?", options: ["HyperText Transfer Protocol", "High Text Transfer Protocol", "HyperText Transmission Protocol", "High Transfer Text Protocol"], correctAnswer: 0, topic: "Networks" },
        { question: "Which layer of OSI model is responsible for routing?", options: ["Data Link", "Network", "Transport", "Session"], correctAnswer: 1, topic: "Networks" },
        { question: "What is a deadlock in OS?", options: ["Process waiting forever", "Memory overflow", "CPU overload", "Disk failure"], correctAnswer: 0, topic: "Operating Systems" },
        { question: "Which of the following is not a type of JOIN in SQL?", options: ["INNER JOIN", "OUTER JOIN", "CROSS JOIN", "CIRCULAR JOIN"], correctAnswer: 3, topic: "SQL" },
        { question: "Time complexity of inserting into a hash table (average)?", options: ["O(1)", "O(log n)", "O(n)", "O(n²)"], correctAnswer: 0, topic: "Data Structures" },
        { question: "What is normalization in DBMS?", options: ["Adding redundancy", "Reducing redundancy", "Deleting records", "Encrypting data"], correctAnswer: 1, topic: "DBMS" },
        { question: "Which principle states a class should have only one reason to change?", options: ["Open/Closed", "Liskov Substitution", "Single Responsibility", "Interface Segregation"], correctAnswer: 2, topic: "OOP" },
        { question: "What does DFS stand for in graph traversal?", options: ["Data First Search", "Depth First Search", "Direct First Search", "Deep File System"], correctAnswer: 1, topic: "Algorithms" },
        { question: "What is a foreign key?", options: ["Key from another country", "Key referencing primary key of another table", "Unique key", "Composite key"], correctAnswer: 1, topic: "DBMS" },
        { question: "Which protocol is used for secure web communication?", options: ["HTTP", "FTP", "HTTPS", "SMTP"], correctAnswer: 2, topic: "Networks" },
        { question: "What is the output of: 5 & 3 in binary?", options: ["0", "1", "7", "15"], correctAnswer: 1, topic: "Programming" },
        { question: "Which data structure is best for implementing recursion?", options: ["Array", "Queue", "Stack", "Heap"], correctAnswer: 2, topic: "Data Structures" },
        { question: "What is virtual memory?", options: ["RAM extension using disk", "Cache memory", "ROM extension", "Swap space only"], correctAnswer: 0, topic: "Operating Systems" },
        { question: "What does API stand for?", options: ["Application Programming Interface", "Application Process Integration", "Automated Program Interface", "Application Protocol Internet"], correctAnswer: 0, topic: "Programming" }
      ],
      Programming: [
        { question: "What is a pointer in C?", options: ["Variable storing value", "Variable storing address", "Function", "Array element"], correctAnswer: 1, topic: "C Programming" },
        { question: "What is the size of int in a 64-bit system?", options: ["2 bytes", "4 bytes", "8 bytes", "16 bytes"], correctAnswer: 1, topic: "C Programming" },
        { question: "What is 'this' keyword in Java?", options: ["Refers to current class", "Refers to parent class", "Refers to static method", "Refers to interface"], correctAnswer: 0, topic: "Java" },
        { question: "Which keyword is used to prevent inheritance in Java?", options: ["static", "abstract", "final", "private"], correctAnswer: 2, topic: "Java" },
        { question: "What does print(type([])) output in Python?", options: ["<class 'tuple'>", "<class 'list'>", "<class 'dict'>", "<class 'set'>"], correctAnswer: 1, topic: "Python" },
        { question: "What is the correct way to declare a constant in JavaScript?", options: ["var", "let", "const", "static"], correctAnswer: 2, topic: "JavaScript" },
        { question: "Which Python data type is immutable?", options: ["List", "Dictionary", "Set", "Tuple"], correctAnswer: 3, topic: "Python" },
        { question: "What is method overloading?", options: ["Same name, different params", "Same name, same params", "Different names", "Inheritance"], correctAnswer: 0, topic: "OOP" }
      ],
      "HR Interview": [
        { question: "What is the best answer for 'Tell me about yourself'?", options: ["Share personal life", "Share professional background relevant to job", "Repeat your resume", "Talk about hobbies only"], correctAnswer: 1, topic: "HR Questions" },
        { question: "When asked 'What is your greatest weakness?', you should?", options: ["Say you have no weakness", "State a real weakness and how you're improving", "Give a strength disguised as weakness", "Avoid the question"], correctAnswer: 1, topic: "HR Questions" },
        { question: "For 'Where do you see yourself in 5 years?', best response is?", options: ["Running the company", "Vague answer", "Career growth aligned with company goals", "I don't know"], correctAnswer: 2, topic: "HR Questions" },
        { question: "When negotiating salary you should?", options: ["Accept first offer", "Research market rate and give a range", "Demand highest possible", "Avoid discussing salary"], correctAnswer: 1, topic: "Salary Negotiation" },
        { question: "'Why should we hire you?' best approach?", options: ["Say you need the job", "Highlight unique skills matching the JD", "Compare yourself to others", "Say you're the best"], correctAnswer: 1, topic: "HR Questions" },
        { question: "What does STAR method stand for in interviews?", options: ["Skill, Task, Action, Result", "Situation, Task, Action, Result", "Strategy, Team, Achieve, Result", "Skill, Timeline, Achievement, Role"], correctAnswer: 1, topic: "Interview Technique" },
        { question: "Body language in an interview should be?", options: ["Casual and relaxed", "Confident, open posture, eye contact", "Formal and stiff", "Aggressive"], correctAnswer: 1, topic: "Soft Skills" },
        { question: "When asked 'Do you have questions for us?', you should?", options: ["Say No", "Ask about salary immediately", "Ask about team, role, and growth", "Avoid questions"], correctAnswer: 2, topic: "HR Questions" }
      ],
      "Soft Skills": [
        { question: "Active listening means?", options: ["Waiting to speak", "Fully concentrating and understanding the speaker", "Nodding continuously", "Looking attentive without listening"], correctAnswer: 1, topic: "Communication" },
        { question: "Which communication style is most effective professionally?", options: ["Aggressive", "Passive", "Assertive", "Submissive"], correctAnswer: 2, topic: "Communication" },
        { question: "What is emotional intelligence?", options: ["IQ level", "Ability to understand and manage emotions", "Memory power", "Technical skills"], correctAnswer: 1, topic: "EQ" },
        { question: "Teamwork means?", options: ["Doing everything yourself", "Collaborating to achieve a common goal", "Following leader blindly", "Competing with teammates"], correctAnswer: 1, topic: "Teamwork" }
      ]
    };

    // ── Select questions from bank matching requested categories ─────────────
    const allCats = [...categories, ...(subTopics || [])];
    let pool = [];

    for (const cat of allCats) {
      // Exact match first
      if (BANK[cat]) { pool.push(...BANK[cat]); continue; }
      // Partial match
      for (const key of Object.keys(BANK)) {
        if (key.toLowerCase().includes(cat.toLowerCase()) || cat.toLowerCase().includes(key.toLowerCase())) {
          pool.push(...BANK[key]);
        }
      }
    }

    // If still empty, use all bank questions
    if (!pool.length) {
      for (const v of Object.values(BANK)) pool.push(...v);
    }

    // Deduplicate by question text
    const seen = new Set();
    pool = pool.filter(q => { if (seen.has(q.question)) return false; seen.add(q.question); return true; });

    // Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const questions = pool.slice(0, questionCount).map(q => ({
      question: q.question,
      options: q.options,
      correctAnswer: q.correctAnswer,
      topic: q.topic || categories[0],
      marks: 1
    }));

    res.json({ success: true, questions });
  } catch (e) {
    console.error('Quiz gen error:', e.stack || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── PLACEMENT CHATBOT ───────────────────────────────────────────────────────
// ─── CHAT ROUTE ──────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    const systemPrompt = `You are PlacementCoach, an expert AI assistant for engineering students preparing for placements. Be concise, friendly, and practical.`;

    const messages = [
      ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const reply = await askAI(systemPrompt, messages);

    res.json({ success: true, reply });
  } catch (e) {
    console.error("🔥 AI ERROR:", e.message);
    res.status(500).json({ error: "AI unavailable. Please try again." });
  }
});

// ─── AI CONNECTION TEST ───────────────────────────────────────────────────────
app.get('/api/quiz/test', async (req, res) => {
  try {
    const reply = await geminiRequest('You are a helpful assistant.', [{ role: 'user', content: 'Say hello in one word.' }], 20);
    res.json({ success: true, provider: 'Gemini 2.0 Flash', response: reply });
  } catch (e) {
    res.json({ success: false, geminiError: e.message, tip: 'Set GEMINI_API_KEY in Render env vars' });
  }
});


app.post('/api/attempts/start', async (req, res) => {
  try {
    const { assessmentId, usn } = req.body;
    const student = await Student.findOne({ usn: usn.toUpperCase() });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    // Check if already attempted
    const existing = await AssignmentAttempt.findOne({ assessmentId, usn: usn.toUpperCase() });
    if (existing && existing.status !== 'in-progress') return res.json({ success: false, error: 'Already submitted', attempt: existing });
    if (existing) return res.json({ success: true, attempt: existing });
    const attempt = await new AssignmentAttempt({
      assessmentId, studentId: student._id, usn: student.usn, studentName: student.name
    }).save();
    res.json({ success: true, attempt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/attempts/:id/warning', async (req, res) => {
  try {
    const { event } = req.body;
    const attempt = await AssignmentAttempt.findById(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'Not found' });
    attempt.tabSwitchCount = (attempt.tabSwitchCount || 0) + 1;
    attempt.warnings = (attempt.warnings || 0) + 1;
    attempt.malpracticeLog = attempt.malpracticeLog || [];
    attempt.malpracticeLog.push({ event: event || 'Tab switch detected', timestamp: new Date() });
    if (attempt.warnings >= 3) {
      attempt.status = 'malpractice';
      attempt.isMalpractice = true;
      attempt.submittedAt = new Date();
    }
    await attempt.save();
    res.json({ success: true, warnings: attempt.warnings, isMalpractice: attempt.isMalpractice });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/attempts/:id/submit', async (req, res) => {
  try {
    const { answers, forced } = req.body;
    const attempt = await AssignmentAttempt.findById(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'Not found' });
    const assessment = await Assessment.findById(attempt.assessmentId);
    if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
    let score = 0;
    assessment.questions.forEach((q, i) => {
      if (answers && answers[i] !== undefined && parseInt(answers[i]) === q.correctAnswer) score += q.marks || 1;
    });
    attempt.status = attempt.isMalpractice ? 'malpractice' : 'submitted';
    attempt.submittedAt = new Date();
    attempt.answers = answers;
    attempt.score = score;
    attempt.maxScore = assessment.totalMarks;
    await attempt.save();
    // Update student score too
    const student = await Student.findOne({ usn: attempt.usn });
    if (student && !student.assessmentScores.find(a => a.assessmentId?.toString() === assessment._id.toString())) {
      student.assessmentScores.push({ assessmentId: assessment._id, score, maxScore: assessment.totalMarks, submittedAt: new Date() });
      await student.save();
    }
    res.json({ success: true, score, maxScore: assessment.totalMarks, percentage: Math.round((score / (assessment.totalMarks || 1)) * 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attempts/assessment/:assessmentId', async (req, res) => {
  try {
    const attempts = await AssignmentAttempt.find({ assessmentId: req.params.assessmentId }).sort({ startedAt: -1 });
    res.json(attempts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attempts/all', async (req, res) => {
  try {
    const attempts = await AssignmentAttempt.find().sort({ startedAt: -1 }).limit(200);
    res.json(attempts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/assessments', async (req, res) => {
  try { res.json(await Assessment.find().sort({ createdAt: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/assessments', async (req, res) => {
  try {
    const totalMarks = (req.body.questions || []).reduce((s, q) => s + (q.marks || 1), 0);
    const a = await new Assessment({ ...req.body, totalMarks }).save();
    res.json({ success: true, assessment: a });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/assessments/:id/toggle', async (req, res) => {
  try { const a = await Assessment.findById(req.params.id); a.isActive = !a.isActive; await a.save(); res.json({ success: true, isActive: a.isActive }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/assessments/:id', async (req, res) => {
  try { await Assessment.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/assessments/:id/take', async (req, res) => {
  try {
    const a = await Assessment.findById(req.params.id);
    if (!a || !a.isActive) return res.status(404).json({ error: 'Assessment not available' });
    res.json({ _id: a._id, title: a.title, type: a.type, timeLimit: a.timeLimit, totalMarks: a.totalMarks, questions: a.questions.map(q => ({ _id: q._id, question: q.question, options: q.options, marks: q.marks })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/assessments/:id/submit', async (req, res) => {
  try {
    const { usn, answers, attemptId } = req.body;
    const assessment = await Assessment.findById(req.params.id);
    if (!assessment) return res.status(404).json({ error: 'Not found' });
    let score = 0;
    assessment.questions.forEach((q, i) => { if (answers[i] !== undefined && parseInt(answers[i]) === q.correctAnswer) score += q.marks || 1; });
    const student = await Student.findOne({ usn: usn.toUpperCase() });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (!student.assessmentScores.find(a => a.assessmentId?.toString() === assessment._id.toString())) {
      student.assessmentScores.push({ assessmentId: assessment._id, score, maxScore: assessment.totalMarks, submittedAt: new Date() });
      await student.save();
    }
    // Update attempt if provided
    if (attemptId) {
      await AssignmentAttempt.findByIdAndUpdate(attemptId, { status: 'submitted', submittedAt: new Date(), answers, score, maxScore: assessment.totalMarks });
    }
    res.json({ success: true, score, maxScore: assessment.totalMarks, percentage: Math.round((score / assessment.totalMarks) * 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NOTIFICATION ROUTES ──────────────────────────────────────────────────────
app.get('/api/notifications/:usn', async (req, res) => {
  try { res.json(await Notification.find({ usn: req.params.usn.toUpperCase() }).sort({ createdAt: -1 }).limit(20)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/:id/read', async (req, res) => {
  try { await Notification.findByIdAndUpdate(req.params.id, { isRead: true }); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/notifications/markall/:usn', async (req, res) => {
  try { await Notification.updateMany({ usn: req.params.usn, isRead: false }, { isRead: true }); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [totalStudents, totalDrives, activeDrives, totalAssessments, placedStudents, branchStats, recentDrives, cgpaRanges] = await Promise.all([
      Student.countDocuments(),
      Drive.countDocuments(),
      Drive.countDocuments({ status: 'active' }),
      Assessment.countDocuments(),
      Student.countDocuments({ 'driveApplications.status': 'shortlisted' }),
      Student.aggregate([{ $group: { _id: '$branch', count: { $sum: 1 }, avgCGPA: { $avg: '$cgpa' } } }, { $sort: { count: -1 } }]),
      Drive.find().sort({ createdAt: -1 }).limit(5),
      Student.aggregate([{ $bucket: { groupBy: '$cgpa', boundaries: [0, 6, 7, 8, 9, 10.1], default: 'Other', output: { count: { $sum: 1 } } } }])
    ]);
    res.json({ totalStudents, totalDrives, activeDrives, totalAssessments, placedStudents, branchStats, recentDrives, cgpaRanges });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GOOGLE FORMS WEBHOOK ─────────────────────────────────────────────────────
// Matches EXACT field names from the college Google Form:
// Email, USN, Full Name, Gender, Personal Email id, Mobile Number,
// % Marks -10th, 10th Board, % Marks -12th, 12th Board,
// Diploma %, Diploma Board, Branch, Current CGPA Graduation,
// Number of on going Backlogs, Number of history of Backlogs,
// Present Address, Permanent Address, Aadhar No

app.post('/api/form-submit', async (req, res) => {
  try {
    const raw = req.body;

    // Normalize all incoming keys: lowercase + collapse spaces
    const d = {};
    Object.keys(raw).forEach(k => {
      d[k.toLowerCase().trim().replace(/\s+/g, ' ')] = (raw[k] || '').toString().trim();
    });

    // ── Field mapping (exact form labels, lowercased) ──────────────────────
    const collegeEmail = d['email'] || '';
    const usn = d['usn'] || '';
    const name = d['full name'] || '';
    const gender = d['gender'] || '';
    const personalEmail = d['personal email id'] || '';
    const phone = d['mobile number'] || '';
    const marks10th = d['% marks -10th'] || '';
    const board10th = d['10th board(example: kseeb/cbse/icse)'] ||
      d['10th board'] || '';
    const marks12th = d['% marks -12th'] || '';
    const board12th = d['12th board(example: department of pre university/cbse)'] ||
      d['12th board'] || '';
    const diplomaPct = d['diploma %'] || '';
    const diplomaBoard = d['diploma board (example: board of technical education etc.. )'] ||
      d['diploma board'] || '';
    const branch = d['branch'] || 'CSE';
    const cgpa = parseFloat(d['current cgpa graduation'] || d['cgpa'] || '0') || 0;
    const ongoingBL = parseInt(d['number of on going backlogs'] || d['ongoing backlogs'] || '0') || 0;
    const historyBL = parseInt(d['number of history of backlogs'] || d['history backlogs'] || '0') || 0;
    const presentAddr = d['present address'] || '';
    const permanentAddr = d['permanent address'] || '';
    const aadhar = d['aadhar no'] || '';

    // Use college email as primary, fallback to personal email
    const email = collegeEmail || personalEmail;

    if (!name || !usn) {
      return res.status(400).json({ error: 'Full Name and USN are required' });
    }

    const usnUpper = usn.toUpperCase().trim();

    // Build student document — store all extra fields in a nested "profile" object
    const studentData = {
      name,
      usn: usnUpper,
      branch: branch.toUpperCase().trim(),
      year: 4,                // default final year; form doesn't ask year
      cgpa,
      backlogs: ongoingBL,        // ongoing backlogs used for placement eligibility
      email,
      phone,
      password: 'student123',
      // Extended profile fields stored as extra data
      profile: {
        gender,
        personalEmail,
        collegeEmail,
        marks10th,
        board10th,
        marks12th,
        board12th,
        diplomaPct,
        diplomaBoard,
        ongoingBacklogs: ongoingBL,
        historyBacklogs: historyBL,
        presentAddress: presentAddr,
        permanentAddress: permanentAddr,
        aadharNo: aadhar
      }
    };

    // Upsert: update existing student if USN already exists, else create new
    // Use $set so existing doc is updated (not replaced), preventing duplicates
    await Student.findOneAndUpdate(
      { usn: usnUpper },
      { $set: studentData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`✅ Form saved: ${name} (${usnUpper}) | CGPA: ${cgpa} | Branch: ${branch}`);
    res.json({ success: true, message: `${name} (${usnUpper}) saved to database` });

  } catch (e) {
    console.error('❌ Form submit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Health check — visit this URL to confirm endpoint is live
app.get('/api/form-submit', (req, res) => {
  res.json({ status: 'ok', message: 'PlacementPro form endpoint is live ✅', endpoint: 'POST /api/form-submit' });
});

// ─── ALUMNI AUTH ──────────────────────────────────────────────────────────────
app.post('/api/auth/google-alumni', async (req, res) => {
  try {
    const { credential, name, company, designation, linkedin, github, gmail, branch, gradYear } = req.body;
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email;
    const displayName = (name || payload.name || '').trim();

    let alumni = await Alumni.findOne({ email });
    if (alumni && alumni.profileComplete) {
      // Returning alumni — just login
      req.session.user = { role: 'alumni', id: alumni._id, email, name: alumni.name };
      return res.json({ success: true, returning: true, name: alumni.name });
    }
    // New alumni or incomplete profile — save details
    const data = {
      name: displayName, email,
      company: company || '', designation: designation || '',
      linkedin: linkedin || '', github: github || '', gmail: gmail || email,
      branch: branch || '', gradYear: parseInt(gradYear) || 0,
      profileComplete: !!(company && designation)
    };
    if (alumni) {
      Object.assign(alumni, data);
      await alumni.save();
    } else {
      alumni = await new Alumni(data).save();
    }
    req.session.user = { role: 'alumni', id: alumni._id, email, name: alumni.name };
    res.json({ success: true, returning: false, name: alumni.name, needsProfile: !alumni.profileComplete });
  } catch (err) {
    console.error('Alumni Google auth error:', err);
    res.json({ success: false, error: 'Alumni login failed' });
  }
});

// ─── ALUMNI PROFILE ───────────────────────────────────────────────────────────
app.get('/api/alumni/me', async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== 'alumni') return res.status(401).json({ error: 'Not authenticated' });
    const alumni = await Alumni.findById(req.session.user.id);
    if (!alumni) return res.status(404).json({ error: 'Alumni not found' });
    res.json(alumni);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/alumni/me', async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== 'alumni') return res.status(401).json({ error: 'Not authenticated' });
    const updated = await Alumni.findByIdAndUpdate(req.session.user.id, { $set: { ...req.body, profileComplete: true } }, { new: true });
    res.json({ success: true, alumni: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── ALUMNI GROUP ROUTES ──────────────────────────────────────────────────────
app.get('/api/alumni/groups', async (req, res) => {
  try { res.json(await AlumniGroup.find().sort({ createdAt: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alumni/groups', async (req, res) => {
  try {
    const { companyTag, createdBy, creatorName, creatorRole } = req.body;
    if (!companyTag) return res.status(400).json({ error: 'Company name is required' });
    const name = companyTag.trim() + ' Family';
    const group = await new AlumniGroup({
      name, companyTag: companyTag.trim(), createdBy, creatorName, creatorRole: creatorRole || 'student',
      members: [{ userId: createdBy, name: creatorName, role: creatorRole || 'student' }]
    }).save();
    res.json({ success: true, group });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/alumni/groups/:id/join', async (req, res) => {
  try {
    const { userId, name, role } = req.body;
    const group = await AlumniGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.members.find(m => m.userId === userId)) return res.json({ success: true, message: 'Already a member' });
    group.members.push({ userId, name, role: role || 'student' });
    await group.save();
    res.json({ success: true, group });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/alumni/groups/:id', async (req, res) => {
  try {
    await AlumniGroup.findByIdAndDelete(req.params.id);
    await GroupMessage.deleteMany({ groupId: req.params.id });
    await PrivateMessage.deleteMany({ groupId: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/alumni/groups/:id/members', async (req, res) => {
  try {
    const group = await AlumniGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    // Get full alumni profiles for alumni members
    const alumniMembers = group.members.filter(m => m.role === 'alumni');
    const alumniProfiles = await Alumni.find({ _id: { $in: alumniMembers.map(m => m.userId) } });
    res.json({ members: group.members, alumniProfiles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GROUP MESSAGES ───────────────────────────────────────────────────────────
app.get('/api/alumni/groups/:id/messages/:section', async (req, res) => {
  try {
    const messages = await GroupMessage.find({ groupId: req.params.id, section: req.params.section }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alumni/groups/:id/messages', upload.single('file'), async (req, res) => {
  try {
    const { section, senderId, senderName, senderRole, content } = req.body;
    // Only alumni can post to the resource section
    if (section === 'resource' && senderRole !== 'alumni') {
      return res.status(403).json({ error: 'Only alumni can upload resources' });
    }
    const msg = { groupId: req.params.id, section: section || 'general', senderId, senderName, senderRole: senderRole || 'student', content: content || '' };
    if (req.file) {
      msg.fileName = req.file.originalname;
      msg.fileUrl = '/uploads/' + req.file.filename;
    }
    const saved = await new GroupMessage(msg).save();
    res.json({ success: true, message: saved });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── PRIVATE MESSAGES (Student ↔ Alumni) ──────────────────────────────────────
app.get('/api/alumni/private/:groupId/:alumniId', async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const userId = req.session.user.id || req.session.user.username;
    const { groupId, alumniId } = req.params;
    const messages = await PrivateMessage.find({
      groupId,
      $or: [
        { studentId: userId, alumniId },
        { studentId: alumniId, alumniId: userId }
      ]
    }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alumni/private', async (req, res) => {
  try {
    const { groupId, studentId, alumniId, senderId, senderRole, senderName, content } = req.body;
    const msg = await new PrivateMessage({ groupId, studentId, alumniId, senderId, senderRole, senderName, content }).save();
    res.json({ success: true, message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Get alumni list for alumni connect
app.get('/api/alumni/list', async (req, res) => {
  try { res.json(await Alumni.find({ profileComplete: true }).select('-__v')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RESUME WIZARD — AI Comparison ───────────────────────────────────────────
app.post('/api/resume/compare', async (req, res) => {
  const { resume_data, company, role } = req.body;
  const pkg = req.body.package || '';
  const prompt = `You are a senior technical recruiter with 10+ years of experience at top tech companies.
A student wants to work at: ${company} | Role: ${role} | Package: ${pkg}
Student profile: CGPA ${resume_data.cgpa || 'N/A'}, Skills: ${(resume_data.skills || []).join(', ')}, Projects: ${(resume_data.projects || []).length}, Internships: ${(resume_data.internships || []).length}, Achievements: ${(resume_data.achievements || []).length}

Generate a realistic benchmark comparison. Respond ONLY with valid JSON (no markdown):
{"benchmark":{"summary":"string","cgpa":"string","key_skills":["skill1","skill2"],"projects_count":3,"internships":"string","certifications":["cert1"]},"match_score":72,"strengths":["strength1","strength2","strength3"],"gaps":["gap1","gap2","gap3"],"action_items":["action1","action2","action3"],"verdict":"string"}`;
  try {
    const raw = await askAI('You are a technical recruiter. Respond only with valid JSON, no markdown formatting.', [{ role: 'user', content: prompt }]);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    res.json({ success: true, comparison: result });
  } catch (e) {
    res.status(500).json({ success: false, error: 'AI comparison failed: ' + e.message });
  }
});

// ─── INTERVIEW SCHEDULER ──────────────────────────────────────────────────────

// GET shortlisted (or eligible fallback) students for a drive
app.get('/api/interview/shortlisted/:driveId', async (req, res) => {
  try {
    const drive = await Drive.findById(req.params.driveId);
    if (!drive) return res.status(404).json({ error: 'Drive not found' });
    // First try formally shortlisted
    let students = await Student.find({
      'driveApplications': { $elemMatch: { driveId: drive._id, status: 'shortlisted' } }
    }).select('name usn branch year cgpa email phone');
    // Fallback: eligible students if shortlist hasn't been confirmed yet
    if (!students.length) {
      const q = { cgpa: { $gte: drive.minCGPA }, backlogs: { $lte: drive.maxBacklogs || 0 } };
      if (drive.eligibleBranches?.length) q.branch = { $in: drive.eligibleBranches };
      if (drive.eligibleYear?.length) q.year = { $in: drive.eligibleYear };
      students = await Student.find(q).select('name usn branch year cgpa email phone');
    }
    res.json({ students });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET slots (filter by driveId query param)
app.get('/api/interview/slots', async (req, res) => {
  try {
    const q = {};
    if (req.query.driveId) q.driveId = req.query.driveId;
    const slots = await InterviewSlot.find(q).sort({ date: 1, startTime: 1 });
    res.json({ slots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create slot with overlap prevention
app.post('/api/interview/slots', async (req, res) => {
  try {
    const { driveId, studentId, studentName, usn, studentEmail, date, startTime, endTime, mode, location, notes, driveName } = req.body;
    if (!driveId || !studentName || !usn || !date || !startTime || !endTime)
      return res.status(400).json({ error: 'Missing required fields' });
    const slotDate = new Date(date);
    const dayStart = new Date(slotDate); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(slotDate); dayEnd.setHours(23, 59, 59, 999);
    // Overlap check: same drive, same day, same start time
    const overlap = await InterviewSlot.findOne({ driveId, date: { $gte: dayStart, $lte: dayEnd }, startTime });
    if (overlap) return res.status(409).json({ error: `${overlap.studentName} already has a slot at ${startTime}` });
    const slot = await new InterviewSlot({ driveId, driveName: driveName || '', studentId, studentName, usn, studentEmail: studentEmail || '', date: slotDate, startTime, endTime, mode: mode || 'online', location: location || '', notes: notes || '' }).save();
    res.json({ success: true, slot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update a slot (date/time/mode/location/notes)
app.put('/api/interview/slots/:id', async (req, res) => {
  try {
    const { date, startTime, endTime, mode, location, notes } = req.body;
    const existing = await InterviewSlot.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Slot not found' });
    if (date && startTime) {
      const slotDate = new Date(date);
      const dayStart = new Date(slotDate); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(slotDate); dayEnd.setHours(23, 59, 59, 999);
      const overlap = await InterviewSlot.findOne({ _id: { $ne: req.params.id }, driveId: existing.driveId, date: { $gte: dayStart, $lte: dayEnd }, startTime });
      if (overlap) return res.status(409).json({ error: `${overlap.studentName} already has a slot at this time` });
    }
    const upd = {};
    if (date) upd.date = new Date(date);
    if (startTime) upd.startTime = startTime;
    if (endTime) upd.endTime = endTime;
    if (mode) upd.mode = mode;
    if (location !== undefined) upd.location = location;
    if (notes !== undefined) upd.notes = notes;
    const slot = await InterviewSlot.findByIdAndUpdate(req.params.id, { $set: upd }, { new: true });
    res.json({ success: true, slot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE a slot
app.delete('/api/interview/slots/:id', async (req, res) => {
  try {
    await InterviewSlot.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST notify one student about their interview slot
app.post('/api/interview/notify/:slotId', async (req, res) => {
  try {
    const slot = await InterviewSlot.findById(req.params.slotId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    const fmtT = t => { const [h, m] = t.split(':'); const hr = parseInt(h); return `${hr > 12 ? hr - 12 : (hr === 0 ? 12 : hr)}:${m} ${hr >= 12 ? 'PM' : 'AM'}`; };
    const p = n => String(n).padStart(2, '0');
    const d = new Date(slot.date);
    const [sh, sm] = slot.startTime.split(':'); const [eh, em] = slot.endTime.split(':');
    const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE`
      + `&text=${encodeURIComponent('Interview – ' + (slot.driveName || 'Campus Placement'))}`
      + `&dates=${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(sh)}${p(sm)}00`
      + `%2F${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(eh)}${p(em)}00`
      + `&details=${encodeURIComponent('Interview via PlacementPro\nDrive: ' + (slot.driveName || '') + (slot.location ? '\nVenue: ' + slot.location : '') + (slot.notes ? '\nNotes: ' + slot.notes : ''))}`
      + `&location=${encodeURIComponent(slot.location || 'Campus')}&ctz=Asia%2FKolkata`;
    const slotDateStr = new Date(slot.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const msg = `Your interview for ${slot.driveName} is scheduled on ${slotDateStr} from ${fmtT(slot.startTime)} to ${fmtT(slot.endTime)}. Mode: ${slot.mode}${slot.location ? ' | Venue: ' + slot.location : ''}${slot.notes ? ' | Note: ' + slot.notes : ''}. 📅 Add to Google Calendar: ${gcal}`;
    await Notification.findOneAndUpdate(
      { usn: slot.usn.toUpperCase(), type: 'general', title: { $regex: slot.driveName, $options: 'i' } },
      { studentId: slot.studentId, usn: slot.usn.toUpperCase(), title: `📅 Interview Scheduled: ${slot.driveName}`, message: msg, type: 'general', isRead: false, createdAt: new Date() },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST bulk notify all scheduled students for a drive
app.post('/api/interview/notify-bulk/:driveId', async (req, res) => {
  try {
    const slots = await InterviewSlot.find({ driveId: req.params.driveId, status: 'scheduled' });
    if (!slots.length) return res.json({ success: true, notified: 0 });
    const fmtT = t => { const [h, m] = t.split(':'); const hr = parseInt(h); return `${hr > 12 ? hr - 12 : (hr === 0 ? 12 : hr)}:${m} ${hr >= 12 ? 'PM' : 'AM'}`; };
    const p = n => String(n).padStart(2, '0');
    let notified = 0;
    for (const slot of slots) {
      const d = new Date(slot.date);
      const [sh, sm] = slot.startTime.split(':'); const [eh, em] = slot.endTime.split(':');
      const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE`
        + `&text=${encodeURIComponent('Interview – ' + (slot.driveName || 'Campus Placement'))}`
        + `&dates=${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(sh)}${p(sm)}00`
        + `%2F${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(eh)}${p(em)}00`
        + `&details=${encodeURIComponent('Interview via PlacementPro\nDrive: ' + (slot.driveName || '') + (slot.location ? '\nVenue: ' + slot.location : '') + (slot.notes ? '\nNotes: ' + slot.notes : ''))}`
        + `&location=${encodeURIComponent(slot.location || 'Campus')}&ctz=Asia%2FKolkata`;
      const slotDateStr = new Date(slot.date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
      const msg = `Interview for ${slot.driveName}: ${slotDateStr}, ${fmtT(slot.startTime)}–${fmtT(slot.endTime)}. Mode: ${slot.mode}${slot.location ? ' | Venue: ' + slot.location : ''}${slot.notes ? ' | Note: ' + slot.notes : ''}. 📅 Add to Calendar: ${gcal}`;
      await Notification.findOneAndUpdate(
        { usn: slot.usn.toUpperCase(), type: 'general', title: { $regex: slot.driveName, $options: 'i' } },
        { studentId: slot.studentId, usn: slot.usn.toUpperCase(), title: `📅 Interview Scheduled: ${slot.driveName}`, message: msg, type: 'general', isRead: false, createdAt: new Date() },
        { upsert: true }
      );
      notified++;
    }
    res.json({ success: true, notified });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'dashboard1.html')));
app.get('/dashboard1', (req, res) => res.sendFile(path.join(__dirname, 'dashboard1.html')));
app.get('/alumni-login', (req, res) => res.sendFile(path.join(__dirname, 'index1.html')));
app.get('/index1', (req, res) => res.sendFile(path.join(__dirname, 'index1.html')));
app.get('/index1.html', (req, res) => res.sendFile(path.join(__dirname, 'index1.html')));
app.get('/alumni', (req, res) => res.sendFile(path.join(__dirname, 'dashboard-alumni.html')));
app.get('/alumni-connect', (req, res) => res.sendFile(path.join(__dirname, 'alumni-connect.html')));
// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`🚀 PlacementPro running on http://localhost:${PORT}`));