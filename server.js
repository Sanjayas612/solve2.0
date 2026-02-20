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

// ─── OPENROUTER HELPER (works on all Node versions) ──────────────────────────
function openRouterRequest(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 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',
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://solve-q7hx.onrender.com',
        'X-Title': 'PlacementPro Quiz Generator',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON from OpenRouter: ' + data.substring(0, 300))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenRouter request timed out')); });
    req.write(payload);
    req.end();
  });
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
  name:              { type: String, required: true },
  usn:               { type: String, required: true, unique: true },
  branch:            { type: String, required: true },
  year:              { type: Number, required: true },
  cgpa:              { type: Number, required: true },
  backlogs:          { type: Number, default: 0 },
  email:             String,
  phone:             String,
  interestedCompanies: [String],
  assessmentScores:  [{ assessmentId: mongoose.Schema.Types.ObjectId, score: Number, maxScore: Number, submittedAt: Date }],
  driveApplications: [{ driveId: mongoose.Schema.Types.ObjectId, status: { type: String, enum: ['eligible','applied','shortlisted','selected','rejected'], default: 'eligible' }, ranking: { type: String, enum: ['Best','Better','Average'] } }],
  password:          { type: String, default: 'student123' },
  // Extended profile from Google Form
  profile: {
    gender:           String,
    personalEmail:    String,
    collegeEmail:     String,
    marks10th:        String,
    board10th:        String,
    marks12th:        String,
    board12th:        String,
    diplomaPct:       String,
    diplomaBoard:     String,
    ongoingBacklogs:  Number,
    historyBacklogs:  Number,
    presentAddress:   String,
    permanentAddress: String,
    aadharNo:         String
  },
  createdAt:         { type: Date, default: Date.now }
}));

const Drive = mongoose.model('Drive', new mongoose.Schema({
  companyName:      { type: String, required: true },
  description:      String,
  minCGPA:          { type: Number, required: true },
  maxBacklogs:      { type: Number, default: 0 },
  eligibleBranches: [String],
  eligibleYear:     [Number],
  minAssessmentScore: { type: Number, default: 0 },
  driveDate:        Date,
  deadline:         Date,
  package:          String,
  location:         String,
  status:           { type: String, enum: ['upcoming','active','completed'], default: 'upcoming' },
  eligibleCount:    { type: Number, default: 0 },
  createdAt:        { type: Date, default: Date.now }
}));

const Assessment = mongoose.model('Assessment', new mongoose.Schema({
  title:       { type: String, required: true },
  type:        { type: String, default: 'Mixed' },
  categories:  [String],
  subTopics:   [String],
  driveId:     mongoose.Schema.Types.ObjectId,
  questions:   [{ question: String, options: [String], correctAnswer: Number, marks: { type: Number, default: 1 }, topic: String }],
  timeLimit:   { type: Number, default: 30 },
  totalMarks:  Number,
  isActive:    { type: Boolean, default: false },
  aiGenerated: { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now }
}));

const AssignmentAttempt = mongoose.model('AssignmentAttempt', new mongoose.Schema({
  assessmentId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  studentId:      { type: mongoose.Schema.Types.ObjectId, required: true },
  usn:            { type: String, required: true },
  studentName:    String,
  status:         { type: String, enum: ['in-progress','submitted','malpractice'], default: 'in-progress' },
  startedAt:      { type: Date, default: Date.now },
  submittedAt:    Date,
  answers:        mongoose.Schema.Types.Mixed,
  score:          Number,
  maxScore:       Number,
  tabSwitchCount: { type: Number, default: 0 },
  warnings:       { type: Number, default: 0 },
  malpracticeLog: [{ event: String, timestamp: Date }],
  isMalpractice:  { type: Boolean, default: false }
}));

const Notification = mongoose.model('Notification', new mongoose.Schema({
  studentId: mongoose.Schema.Types.ObjectId,
  usn:       String,
  title:     String,
  message:   String,
  type:      { type: String, enum: ['drive','assessment','shortlist','general'], default: 'general' },
  driveId:   mongoose.Schema.Types.ObjectId,
  isRead:    { type: Boolean, default: false },
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

// ─── AI QUIZ GENERATION ───────────────────────────────────────────────────────
app.post('/api/quiz/generate', async (req, res) => {
  try {
    const { categories, subTopics, questionCount = 10, difficulty = 'mixed' } = req.body;
    if (!categories || !categories.length) return res.status(400).json({ error: 'Categories required' });

    const topicList = [...categories, ...(subTopics || [])].join(', ');
    const prompt = `You are an expert technical interview question creator for campus placements in India. Generate exactly ${questionCount} unique multiple-choice questions covering: ${topicList}.

Rules:
- Difficulty: ${difficulty}
- Each question MUST be completely unique
- Questions must be placement/campus interview focused
- Return ONLY a raw JSON object — no markdown, no code fences, no explanation

Required JSON structure (return exactly this, nothing else):
{"questions":[{"question":"Question text?","options":["Option A","Option B","Option C","Option D"],"correctAnswer":0,"topic":"${categories[0]}","marks":1}]}

correctAnswer is 0-indexed (0=A,1=B,2=C,3=D). Generate all ${questionCount} questions now:`;

    // Try models in order until one works
    const MODELS = [
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free',
      'meta-llama/llama-3.2-3b-instruct:free'
    ];

    let content = '';
    let lastError = '';

    for (const model of MODELS) {
      try {
        console.log(`Trying model: ${model}`);
        const data = await openRouterRequest({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 4000
        });

        if (data.error) {
          lastError = `Model ${model}: ${data.error.message || JSON.stringify(data.error)}`;
          console.log('Model error:', lastError);
          continue;
        }

        content = data.choices?.[0]?.message?.content || '';
        if (content.trim()) { console.log('Got content from:', model); break; }
      } catch(e) {
        lastError = e.message;
        console.log(`Model ${model} failed:`, e.message);
      }
    }

    if (!content.trim()) {
      return res.status(500).json({ error: 'All AI models failed. Last error: ' + lastError });
    }

    // Robustly extract JSON
    let parsed;
    try {
      // Strip markdown code fences if present
      let cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
      // Find the JSON object
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1) cleaned = cleaned.substring(start, end + 1);
      parsed = JSON.parse(cleaned);
    } catch(e) {
      console.error('JSON parse failed. Raw content:', content.substring(0, 600));
      return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.', raw: content.substring(0, 300) });
    }

    const questions = parsed.questions || [];
    if (!questions.length) {
      return res.status(500).json({ error: 'AI returned 0 questions. Please try again.' });
    }

    // Ensure all questions have required fields
    const clean = questions.map((q, i) => ({
      question: q.question || `Question ${i+1}`,
      options: Array.isArray(q.options) && q.options.length === 4 ? q.options : ['Option A','Option B','Option C','Option D'],
      correctAnswer: typeof q.correctAnswer === 'number' ? q.correctAnswer : 0,
      topic: q.topic || categories[0],
      marks: q.marks || 1
    }));

    res.json({ success: true, questions: clean });
  } catch(e) {
    console.error('Quiz gen error:', e.stack || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── PLACEMENT CHATBOT ───────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const systemPrompt = `You are PlacementCoach, an expert AI assistant for engineering college students preparing for campus placements in India. You help with:
- Company information (TCS, Infosys, Wipro, Accenture, Google, Amazon, etc.)
- Interview preparation tips and common questions
- Aptitude & reasoning strategies
- Technical topics: DSA, DBMS, OS, Networks, OOP, SQL
- Resume building and soft skills
- Salary expectations and placement trends
- Mock interview advice

Be concise, friendly, and practical. Use bullet points when listing things. Always motivate students.`;

    const messages = [
      ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const MODELS = [
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free'
    ];

    let reply = '';
    for (const model of MODELS) {
      try {
        const data = await openRouterRequest({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          temperature: 0.7,
          max_tokens: 800
        });
        if (data.error) continue;
        reply = data.choices?.[0]?.message?.content || '';
        if (reply.trim()) break;
      } catch(e) { continue; }
    }

    if (!reply.trim()) return res.status(500).json({ error: 'AI unavailable. Please try again.' });
    res.json({ success: true, reply });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI CONNECTION TEST ───────────────────────────────────────────────────────
app.get('/api/quiz/test', async (req, res) => {
  try {
    const data = await openRouterRequest({
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [{ role: 'user', content: 'Say hello in one word.' }],
      max_tokens: 10
    });
    res.json({ success: true, response: data?.choices?.[0]?.message?.content, raw: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
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
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attempts/assessment/:assessmentId', async (req, res) => {
  try {
    const attempts = await AssignmentAttempt.find({ assessmentId: req.params.assessmentId }).sort({ startedAt: -1 });
    res.json(attempts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attempts/all', async (req, res) => {
  try {
    const attempts = await AssignmentAttempt.find().sort({ startedAt: -1 }).limit(200);
    res.json(attempts);
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    const collegeEmail  = d['email']                          || '';
    const usn           = d['usn']                            || '';
    const name          = d['full name']                      || '';
    const gender        = d['gender']                         || '';
    const personalEmail = d['personal email id']              || '';
    const phone         = d['mobile number']                  || '';
    const marks10th     = d['% marks -10th']                  || '';
    const board10th     = d['10th board(example: kseeb/cbse/icse)'] ||
                          d['10th board']                     || '';
    const marks12th     = d['% marks -12th']                  || '';
    const board12th     = d['12th board(example: department of pre university/cbse)'] ||
                          d['12th board']                     || '';
    const diplomaPct    = d['diploma %']                      || '';
    const diplomaBoard  = d['diploma board (example: board of technical education etc.. )'] ||
                          d['diploma board']                  || '';
    const branch        = d['branch']                         || 'CSE';
    const cgpa          = parseFloat(d['current cgpa graduation'] || d['cgpa'] || '0') || 0;
    const ongoingBL     = parseInt(d['number of on going backlogs']  || d['ongoing backlogs'] || '0') || 0;
    const historyBL     = parseInt(d['number of history of backlogs'] || d['history backlogs'] || '0') || 0;
    const presentAddr   = d['present address']                || '';
    const permanentAddr = d['permanent address']              || '';
    const aadhar        = d['aadhar no']                      || '';

    // Use college email as primary, fallback to personal email
    const email = collegeEmail || personalEmail;

    if (!name || !usn) {
      return res.status(400).json({ error: 'Full Name and USN are required' });
    }

    const usnUpper = usn.toUpperCase().trim();

    // Build student document — store all extra fields in a nested "profile" object
    const studentData = {
      name,
      usn:      usnUpper,
      branch:   branch.toUpperCase().trim(),
      year:     4,                // default final year; form doesn't ask year
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
        ongoingBacklogs:  ongoingBL,
        historyBacklogs:  historyBL,
        presentAddress:   presentAddr,
        permanentAddress: permanentAddr,
        aadharNo:         aadhar
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

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'dashboard1.html')));
app.get('/dashboard1', (req, res) => res.sendFile(path.join(__dirname, 'dashboard1.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`🚀 PlacementPro running on http://localhost:${PORT}`));