require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
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
  title:      { type: String, required: true },
  type:       { type: String, enum: ['Aptitude','Technical','Coding'], required: true },
  driveId:    mongoose.Schema.Types.ObjectId,
  questions:  [{ question: String, options: [String], correctAnswer: Number, marks: { type: Number, default: 1 } }],
  timeLimit:  { type: Number, default: 30 },
  totalMarks: Number,
  isActive:   { type: Boolean, default: false },
  createdAt:  { type: Date, default: Date.now }
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
    return res.json({ success: true, role: 'student', name: student.name });
  }
  res.status(400).json({ error: 'Invalid role' });
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email;
    const name = payload.name;

    // 🔒 Allow only vvce.ac.in
    if (!email.endsWith('@vvce.ac.in')) {
      return res.json({ success: false, error: 'Only @vvce.ac.in emails are allowed' });
    }

    // Find or create student
    let student = await Student.findOne({ email });

    if (!student) {
      student = await Student.create({
        name,
        email,
        usn: email.split('@')[0].toUpperCase(),
        branch: 'CSE',
        year: 4,
        cgpa: 0,
        backlogs: 0,
        password: 'google-auth'
      });
    }

    // Save session
    req.session.user = { role: 'student', username: student.usn, id: student._id, email, name: student.name };

    res.json({ success: true, role: 'student', name: student.name });

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
        await Student.findOneAndUpdate({ usn: s.usn }, s, { upsert: true, new: true });
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

// ─── ASSESSMENT ROUTES ────────────────────────────────────────────────────────
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
    const { usn, answers } = req.body;
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
    await Student.findOneAndUpdate(
      { usn: usnUpper },
      studentData,
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