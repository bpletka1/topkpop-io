/**
 * TopKpop.io — Backend API Routes
 * Handles: Registration, Submissions, Leaderboard, Final Accusation, Admin, Scheduler
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const mailchimp = require('@mailchimp/mailchimp_marketing');
const nodemailer = require('nodemailer');
const fs = require('fs');
const cron = require('node-cron');
const path = require('path');
const OpenAI = require('openai');
const { TROVE_PROMPTS, buildUserMessage, parseScore } = require('./scoring-prompts');

// ── OpenAI Client ────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Supabase Client ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    realtime: { transport: WebSocket },
    global: { headers: { 'x-client-info': 'topkpop-io' } },
  }
);

// ── Mailchimp Client ─────────────────────────────────────────────────────────
mailchimp.setConfig({
  apiKey: process.env.MAILCHIMP_API_KEY,
  server: process.env.MAILCHIMP_SERVER_PREFIX || 'us19',
});

const AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;

// ── Gmail Transporter (direct send — no Mailchimp automations needed) ─────────
const gmailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER || 'bpletka1@gmail.com',
    pass: process.env.GMAIL_APP_PASS || 'jalqoqgdlclckgez',
  },
});

// ── Helper: Send HTML email directly via Gmail ────────────────────────────────
// templateFile: filename in pages/emails/ (e.g. 'email1_welcome.html')
// to: email address or array of addresses
// subject: email subject line
// replacements: object of { TOKEN: value } to replace in the HTML
async function sendEmail(templateFile, to, subject, replacements = {}) {
  try {
    const templatePath = path.join(__dirname, '..', 'pages', 'emails', templateFile);
    let html = fs.readFileSync(templatePath, 'utf8');
    // Apply all replacements
    for (const [token, value] of Object.entries(replacements)) {
      html = html.split(token).join(value || '');
    }
    const recipients = Array.isArray(to) ? to.join(',') : to;
    await gmailTransporter.sendMail({
      from: '"Anna Im — TopKpop.io" <bpletka1@gmail.com>',
      to: recipients,
      subject,
      html,
    });
    console.log(`Email sent: "${subject}" → ${recipients}`);
    return true;
  } catch (err) {
    console.error(`Email send error (${templateFile}):`, err.message);
    return false;
  }
}

// ── File Upload (memory storage → Supabase Storage) ──────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
});

// ── Helper: Upload file to Supabase Storage ──────────────────────────────────
async function uploadToSupabase(file, folder) {
  const ext = path.extname(file.originalname);
  const filename = `${folder}/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { data, error } = await supabase.storage
    .from('submissions')
    .upload(filename, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });
  if (error) throw error;
  const { data: urlData } = supabase.storage.from('submissions').getPublicUrl(filename);
  return { path: filename, url: urlData.publicUrl, name: file.originalname };
}

// ── Helper: Oracle AI Scoring ───────────────────────────────────────────────
async function scoreWithOracle(troveNumber, submissionData) {
  try {
    const systemPrompt = TROVE_PROMPTS[troveNumber];
    if (!systemPrompt) throw new Error(`No scoring prompt for Trove ${troveNumber}`);

    const userMessage = buildUserMessage(troveNumber, submissionData);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 1200,
    });

    const responseText = completion.choices[0]?.message?.content || '';
    const score = parseScore(responseText);

    return { score, feedback: responseText, success: true };
  } catch (err) {
    console.error('Oracle scoring error:', err.message);
    return { score: null, feedback: null, success: false, error: err.message };
  }
}

// Detective Anna thank-you messages (randomly selected)
const ANNA_MESSAGES = [
  "Evidence logged, Detective. Every clue you uncover brings us closer to the truth. Stay sharp — the saboteur is still out there.",
  "Nice work. Your submission is on file. The best investigators don't just find clues — they know what they mean. Keep digging.",
  "Case file updated. You're building a strong record, Detective. The truth doesn't hide forever — not from someone paying this close attention.",
  "Submission received. I've seen a lot of investigators come through here. The ones who make it? They never stop asking why. Don't stop now.",
  "Your evidence is in. The investigation is moving forward. Remember — in this case, your classroom is the crime scene and your students are the witnesses.",
];

function getAnnaMessage() {
  return ANNA_MESSAGES[Math.floor(Math.random() * ANNA_MESSAGES.length)];
}

// ── Helper: Add subscriber to Mailchimp ──────────────────────────────────────
async function addToMailchimp(email, firstName, lastName, tags = []) {
  try {
    await mailchimp.lists.addListMember(AUDIENCE_ID, {
      email_address: email,
      status: 'subscribed',
      merge_fields: { FNAME: firstName, LNAME: lastName },
      tags: tags,
    });
    return true;
  } catch (err) {
    // If already subscribed, update tags
    if (err.status === 400) {
      try {
        const hash = require('crypto').createHash('md5').update(email.toLowerCase()).digest('hex');
        await mailchimp.lists.updateListMember(AUDIENCE_ID, hash, {
          merge_fields: { FNAME: firstName, LNAME: lastName },
          tags: tags.map(t => ({ name: t, status: 'active' })),
        });
        return true;
      } catch (e) {
        console.error('Mailchimp update error:', e.message);
        return false;
      }
    }
    console.error('Mailchimp add error:', err.message);
    return false;
  }
}

// ── Helper: Trigger Mailchimp campaign tag ────────────────────────────────────
async function tagSubscriber(email, tag) {
  try {
    const hash = require('crypto').createHash('md5').update(email.toLowerCase()).digest('hex');
    await mailchimp.lists.updateListMemberTags(AUDIENCE_ID, hash, {
      tags: [{ name: tag, status: 'active' }],
    });
    return true;
  } catch (err) {
    console.error('Mailchimp tag error:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'TopKpop.io API' });
});

// ════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ════════════════════════════════════════════════════════════════════════════
router.post('/register', async (req, res) => {
  try {
    const {
      team_name, captain_name, captain_email, school_name, district, role,
      grade_levels, member2_name, member2_email, member3_name, member3_email,
      member4_name, member4_email, agree_terms, agree_iste, welcome_post_url
    } = req.body;

    // Validate required fields
    if (!team_name || !captain_name || !captain_email || !school_name) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!agree_terms || agree_terms !== 'true') {
      return res.status(400).json({ error: 'You must agree to the terms.' });
    }

    // Check for duplicate email
    const { data: existing } = await supabase
      .from('registrations')
      .select('id')
      .eq('captain_email', captain_email.toLowerCase())
      .single();

    if (existing) {
      return res.status(409).json({ error: 'This email is already registered.' });
    }

    // Insert registration
    const { data: reg, error: regError } = await supabase
      .from('registrations')
      .insert({
        team_name: team_name.trim(),
        captain_name: captain_name.trim(),
        captain_email: captain_email.toLowerCase().trim(),
        school_name: school_name.trim(),
        district: district?.trim(),
        role: role?.trim(),
        grade_levels: grade_levels?.trim(),
        member2_name: member2_name?.trim(),
        member2_email: member2_email?.toLowerCase().trim(),
        member3_name: member3_name?.trim(),
        member3_email: member3_email?.toLowerCase().trim(),
        member4_name: member4_name?.trim(),
        member4_email: member4_email?.toLowerCase().trim(),
      })
      .select()
      .single();

    if (regError) throw regError;

    // Add to Mailchimp (for list management only)
    const nameParts = captain_name.trim().split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || '';
    const mcAdded = await addToMailchimp(captain_email.toLowerCase(), firstName, lastName, ['registered', 'trove-01-pending']);

    // Send welcome email directly via Gmail
    const welcomeSent = await sendEmail(
      'email1_welcome.html',
      captain_email.toLowerCase(),
      '🎤 CLASSIFIED: Your TopKpop.io Mission Briefing Has Arrived',
      { '[CAPTAIN_NAME]': firstName, '[TEAM_NAME]': team_name.trim() }
    );
    if (welcomeSent) {
      await supabase.from('registrations').update({ welcome_sent: true }).eq('id', reg.id);
    }

    // Also add team members to Mailchimp and send them the welcome email
    const members = [
      { name: member2_name, email: member2_email },
      { name: member3_name, email: member3_email },
      { name: member4_name, email: member4_email },
    ].filter(m => m.name && m.email);

    for (const member of members) {
      const parts = member.name.trim().split(' ');
      await addToMailchimp(member.email.toLowerCase(), parts[0], parts.slice(1).join(' ') || '', ['registered', 'team-member']);
      await sendEmail(
        'email1_welcome.html',
        member.email.toLowerCase(),
        '🎤 CLASSIFIED: Your TopKpop.io Mission Briefing Has Arrived',
        { '[CAPTAIN_NAME]': parts[0], '[TEAM_NAME]': team_name.trim() }
      );
    }

    // Auto-award +25 welcome bonus if Instagram post URL was provided
    let welcomeBonusAwarded = false;
    if (welcome_post_url?.trim()) {
      try {
        // Create a bonus submission record for the welcome post
        await supabase.from('submissions').insert({
          team_id: reg.id,
          team_name: team_name.trim(),
          trove_number: 0,  // trove 0 = registration bonus
          notes: `Welcome Instagram post: ${welcome_post_url.trim()}`,
          instagram_post_url: welcome_post_url.trim(),
          bonus_score: 25,
          bonus_awarded_at: new Date().toISOString(),
          bonus_awarded_by: 'auto-registration',
          oracle_score: 0,
          final_score: 0,
          scored_at: new Date().toISOString(),
        });
        welcomeBonusAwarded = true;
        console.log(`Welcome bonus awarded to ${team_name} for Instagram post: ${welcome_post_url.trim()}`);
      } catch (bonusErr) {
        console.error('Welcome bonus award error:', bonusErr.message);
      }
    }

    res.json({
      success: true,
      message: `Welcome to the investigation, ${team_name}! Check your email for your mission briefing.`,
      team_id: reg.id,
      welcome_bonus: welcomeBonusAwarded ? '+25 bonus points awarded for your Instagram welcome post!' : null,
    });

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SUBMISSIONS
// ════════════════════════════════════════════════════════════════════════════

// Accept both /submit/1 and /submit/trove-01
function parseTrove(param) {
  if (param === 'trove-01' || param === '1') return 1;
  if (param === 'trove-02' || param === '2') return 2;
  if (param === 'trove-03' || param === '3') return 3;
  return null;
}

// Final Accusation route — alias to /accuse
router.post('/submit/final-accusation', upload.none(), async (req, res) => {
  // Parse body from either JSON or FormData
  const body = req.body || {};
  const { team_name, captain_email, accused_suspect, evidence_summary, motive } = body;

  if (!team_name || !captain_email || !accused_suspect) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Check accusation window
  const { data: settings } = await supabase
    .from('game_settings')
    .select('accusation_open, accusation_close, correct_saboteur, winner_announced')
    .eq('id', 1)
    .single();

  const now = new Date();
  if (settings?.accusation_open && new Date(settings.accusation_open) > now) {
    return res.status(403).json({ error: 'The Final Accusation window is not yet open.' });
  }
  if (settings?.accusation_close && new Date(settings.accusation_close) < now) {
    return res.status(403).json({ error: 'The Final Accusation window has closed.' });
  }

  const { data: team } = await supabase
    .from('registrations')
    .select('id, status')
    .eq('captain_email', captain_email.toLowerCase())
    .single();

  if (!team) return res.status(404).json({ error: 'Team not found.' });

  const { data: existing } = await supabase
    .from('accusations')
    .select('id')
    .eq('team_id', team.id)
    .single();

  if (existing) return res.status(409).json({ error: 'Your team has already submitted a Final Accusation.' });

  const isCorrect = fuzzyMatchSaboteur(accused_suspect, settings?.correct_saboteur);
  const accusationScore = isCorrect ? 100 : 0;

  const { data: acc, error: accError } = await supabase
    .from('accusations')
    .insert({
      team_id: team.id,
      team_name: team_name.trim(),
      accused_suspect: accused_suspect.trim(),
      evidence_summary: evidence_summary?.trim(),
      motive: motive?.trim(),
      is_correct: isCorrect,
      accusation_score: accusationScore,
    })
    .select()
    .single();

  if (accError) return res.status(500).json({ error: 'Failed to submit accusation.' });

  await tagSubscriber(captain_email.toLowerCase(), 'accusation-submitted');
  await checkAndAnnounceWinner();

  res.json({
    success: true,
    message: 'Your accusation has been filed. The truth will be revealed soon.',
    accusation_id: acc.id,
  });
});

router.post('/submit/:trove', upload.fields([
  { name: 'file1', maxCount: 1 },
  { name: 'file2', maxCount: 1 },
  { name: 'file3', maxCount: 1 },
]), async (req, res) => {
  try {
    const troveNumber = parseTrove(req.params.trove);
    if (!troveNumber) {
      return res.status(400).json({ error: 'Invalid trove number.' });
    }

    const { team_name, captain_email, notes, dance_video_link, instagram_post_url } = req.body;

    if (!team_name || !captain_email) {
      return res.status(400).json({ error: 'Team name and email are required.' });
    }

    // Look up team
    const { data: team, error: teamError } = await supabase
      .from('registrations')
      .select('id, status')
      .eq('captain_email', captain_email.toLowerCase())
      .single();

    if (teamError || !team) {
      return res.status(404).json({ error: 'Team not found. Please check your email address.' });
    }

    if (team.status === 'disqualified') {
      return res.status(403).json({ error: 'This team has been disqualified.' });
    }

    // Upload files to Supabase Storage
    const folder = `trove-${troveNumber}/${team.id}`;
    let file1Data = null, file2Data = null, file3Data = null;

    if (req.files?.file1?.[0]) {
      file1Data = await uploadToSupabase(req.files.file1[0], folder);
    }
    if (req.files?.file2?.[0]) {
      file2Data = await uploadToSupabase(req.files.file2[0], folder);
    }
    if (req.files?.file3?.[0]) {
      file3Data = await uploadToSupabase(req.files.file3[0], folder);
    }

    // Build submission payload — include dance video link and instagram URL if provided
    const submissionPayload = {
      team_id: team.id,
      team_name: team_name.trim(),
      trove_number: troveNumber,
      file1_url: file1Data?.url,
      file1_name: file1Data?.name,
      file2_url: file2Data?.url,
      file2_name: file2Data?.name,
      file3_url: file3Data?.url,
      file3_name: file3Data?.name,
      notes: notes?.trim(),
    };
    // Trove 3: save dance video link in notes if provided, and instagram URL for bonus
    if (dance_video_link?.trim()) {
      submissionPayload.notes = [notes?.trim(), `Dance Video: ${dance_video_link.trim()}`].filter(Boolean).join(' | ');
    }
    if (instagram_post_url?.trim()) {
      submissionPayload.instagram_post_url = instagram_post_url.trim();
    }

    // Upsert submission (allow resubmission before scoring)
    const { data: sub, error: subError } = await supabase
      .from('submissions')
      .upsert(submissionPayload, { onConflict: 'team_id,trove_number' })
      .select()
      .single();

    if (subError) throw subError;

    // Send submission confirmation email directly via Gmail
    const troveEmailMap = { 1: 'email2_trove01.html', 2: 'email3_trove02.html', 3: 'email4_trove03.html' };
    const troveSubjectMap = {
      1: '🔍 Trove 01 Confirmed — Identity Locked In',
      2: '🎵 Trove 02 Confirmed — Evidence Song Received',
      3: '🕵️ Trove 03 Confirmed — Final Evidence Secured',
    };
    if (troveEmailMap[troveNumber]) {
      const scoreStr = oracleResult?.success && oracleResult?.score ? `${oracleResult.score}/100` : 'Pending';
      await sendEmail(
        troveEmailMap[troveNumber],
        captain_email.toLowerCase(),
        troveSubjectMap[troveNumber],
        { '*SCORE*': scoreStr, '[TEAM_NAME]': team_name.trim() }
      );
    }
    // Also keep Mailchimp tag for list segmentation
    await tagSubscriber(captain_email.toLowerCase(), `trove-${troveNumber}-submitted`);

    // ── Oracle AI Scoring ───────────────────────────────────────────────────────────────────────────
    const scoringData = {
      team_name: team_name.trim(),
      notes: notes?.trim(),
      text_content: req.body.text_content?.trim() || req.body.lyrics?.trim() || req.body.lesson_plan?.trim() || null,
      file1_name: file1Data?.name,
      file2_name: file2Data?.name,
      file3_name: file3Data?.name,
      // Trove 1: team-written descriptions for accurate Oracle scoring
      avatar_description: req.body.avatar_description?.trim() || null,
      poster_description: req.body.poster_description?.trim() || null,
    };

    const oracleResult = await scoreWithOracle(troveNumber, scoringData);

    if (oracleResult.success && oracleResult.score !== null) {
      // Save oracle score to Supabase (oracle_feedback stored separately if column exists)
      const updatePayload = {
        oracle_score: oracleResult.score,
        final_score: oracleResult.score,
        scored_at: new Date().toISOString(),
      };
      const { error: updateErr } = await supabase
        .from('submissions')
        .update(updatePayload)
        .eq('id', sub.id);
      if (updateErr) console.error('Score save error:', updateErr.message);
    }

    const annaMessage = getAnnaMessage();

    res.json({
      success: true,
      message: `Trove 0${troveNumber} submission received and scored!`,
      submission_id: sub.id,
      score: oracleResult.success ? oracleResult.score : null,
      feedback: oracleResult.success ? oracleResult.feedback : null,
      scoring_available: oracleResult.success,
      anna_message: annaMessage,
    });

  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// LEADERBOARD
// ════════════════════════════════════════════════════════════════════════════

router.get('/leaderboard', async (req, res) => {
  try {
    // Fetch registrations and submissions separately (avoids FK join issues)
    const { data: teams, error: teamsError } = await supabase
      .from('registrations')
      .select('id, team_name, school_name, district, status')
      .neq('status', 'disqualified')
      .order('team_name');
    if (teamsError) throw teamsError;

    const { data: submissions, error: subsError } = await supabase
      .from('submissions')
      .select('team_id, trove_number, final_score, oracle_score, bonus_score')
      .not('team_id', 'is', null);
    if (subsError) throw subsError;

    // Build score map keyed by team_id (includes bonus_score)
    const scoreMap = {};
    (submissions || []).forEach(s => {
      if (!scoreMap[s.team_id]) scoreMap[s.team_id] = { trove1: 0, trove2: 0, trove3: 0, bonus: 0 };
      const score = s.final_score || s.oracle_score || 0;
      const bonus = s.bonus_score || 0;
      if (score > 0) scoreMap[s.team_id][`trove${s.trove_number}`] = score;
      scoreMap[s.team_id].bonus += bonus;
    });

    // Calculate totals and rank (including bonus points)
    const ranked = (teams || []).map(team => {
      const scores = scoreMap[team.id] || { trove1: 0, trove2: 0, trove3: 0, bonus: 0 };
      const total = scores.trove1 + scores.trove2 + scores.trove3 + scores.bonus;
      return {
        team_name: team.team_name,
        school_name: team.school_name,
        district: team.district,
        trove1: scores.trove1,
        trove2: scores.trove2,
        trove3: scores.trove3,
        bonus: scores.bonus,
        total,
        status: team.status,
      };
    }).sort((a, b) => b.total - a.total)
      .map((t, i) => ({ ...t, rank: i + 1 }));

    res.json({ success: true, leaderboard: ranked });

  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to load leaderboard.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FINAL ACCUSATION
// ════════════════════════════════════════════════════════════════════════════

router.post('/accuse', async (req, res) => {
  try {
    const { team_name, captain_email, accused_suspect, evidence_summary, motive } = req.body;

    if (!team_name || !captain_email || !accused_suspect) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Check accusation window is open
    const { data: settings } = await supabase
      .from('game_settings')
      .select('accusation_open, accusation_close, correct_saboteur, winner_announced')
      .eq('id', 1)
      .single();

    const now = new Date();
    if (settings?.accusation_open && new Date(settings.accusation_open) > now) {
      return res.status(403).json({ error: 'The Final Accusation window is not yet open.' });
    }
    if (settings?.accusation_close && new Date(settings.accusation_close) < now) {
      return res.status(403).json({ error: 'The Final Accusation window has closed.' });
    }

    // Look up team
    const { data: team } = await supabase
      .from('registrations')
      .select('id, status')
      .eq('captain_email', captain_email.toLowerCase())
      .single();

    if (!team) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    // Check if already accused
    const { data: existing } = await supabase
      .from('accusations')
      .select('id')
      .eq('team_id', team.id)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Your team has already submitted a Final Accusation.' });
    }

    // Check if correct
    const isCorrect = fuzzyMatchSaboteur(accused_suspect, settings?.correct_saboteur);
    const accusationScore = isCorrect ? 100 : 0;

    // Insert accusation
    const { data: acc, error: accError } = await supabase
      .from('accusations')
      .insert({
        team_id: team.id,
        team_name: team_name.trim(),
        accused_suspect: accused_suspect.trim(),
        evidence_summary: evidence_summary?.trim(),
        motive: motive?.trim(),
        is_correct: isCorrect,
        accusation_score: accusationScore,
      })
      .select()
      .single();

    if (accError) throw accError;

    // Tag in Mailchimp
    await tagSubscriber(captain_email.toLowerCase(), 'accusation-submitted');

    // Trigger winner check
    await checkAndAnnounceWinner();

    res.json({
      success: true,
      message: 'Your accusation has been filed. The truth will be revealed soon.',
      accusation_id: acc.id,
    });

  } catch (err) {
    console.error('Accusation error:', err);
    res.status(500).json({ error: 'Failed to submit accusation.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// WINNER DETERMINATION
// ════════════════════════════════════════════════════════════════════════════

async function checkAndAnnounceWinner() {
  try {
    const { data: settings } = await supabase
      .from('game_settings')
      .select('accusation_close, winner_announced, winner_team_id')
      .eq('id', 1)
      .single();

    if (settings?.winner_announced) return; // Already done

    const now = new Date();
    if (!settings?.accusation_close || new Date(settings.accusation_close) > now) return; // Window still open

    // Get all teams with scores and accusations (manual join to avoid FK issues)
    const { data: teams } = await supabase
      .from('registrations')
      .select('id, team_name, captain_name, captain_email, school_name')
      .neq('status', 'disqualified');

    if (!teams || teams.length === 0) return;

    const { data: allSubs } = await supabase
      .from('submissions')
      .select('team_id, trove_number, final_score, oracle_score')
      .not('team_id', 'is', null);

    const { data: allAcc } = await supabase
      .from('accusations')
      .select('team_id, is_correct, accusation_score')
      .not('team_id', 'is', null);

    const subsMap = {};
    (allSubs || []).forEach(s => {
      if (!subsMap[s.team_id]) subsMap[s.team_id] = [];
      subsMap[s.team_id].push(s);
    });
    const accMap = {};
    (allAcc || []).forEach(a => { accMap[a.team_id] = a; });

    // Calculate total scores
    const scored = teams.map(team => {
      let total = 0;
      (subsMap[team.id] || []).forEach(s => {
        const score = s.final_score || s.oracle_score || 0;
        total += score;
      });
      const acc = accMap[team.id];
      if (acc?.accusation_score) total += acc.accusation_score;
      return { ...team, total_score: total, correct_accusation: acc?.is_correct || false };
    });

    // Winner = highest score with correct accusation first, then just highest score
    const withCorrect = scored.filter(t => t.correct_accusation).sort((a, b) => b.total_score - a.total_score);
    const winner = withCorrect.length > 0 ? withCorrect[0] : scored.sort((a, b) => b.total_score - a.total_score)[0];

    if (!winner) return;

    // ── HOLD FOR ADMIN APPROVAL ─────────────────────────────────────────────
    // Do NOT send winner email yet — mark as pending approval and notify admin
    await supabase.from('game_settings').update({
      winner_pending_approval: true,
      winner_team_id: winner.id,
      winner_data: JSON.stringify({
        team_name: winner.team_name,
        captain_name: winner.captain_name,
        captain_email: winner.captain_email,
        school_name: winner.school_name,
        total_score: winner.total_score,
        correct_accusation: winner.correct_accusation,
      }),
    }).eq('id', 1);

    // Notify admin that winner is ready for approval
    await notifyAdminWinnerReady(winner, scored);

    console.log(`Winner calculated (PENDING ADMIN APPROVAL): ${winner.team_name} (${winner.captain_email}) — Score: ${winner.total_score}`);

  } catch (err) {
    console.error('Winner check error:', err);
  }
}

// ── Notify admin that a winner is ready for approval ───────────────────────────
async function notifyAdminWinnerReady(winner, allScored) {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@topkpop.io';
    const leaderboard = allScored
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 5)
      .map((t, i) => `${i+1}. ${t.team_name} — ${t.total_score} pts${t.correct_accusation ? ' ✓ Correct Accusation' : ''}`);

    const subject = '🚨 TopKpop.io — Winner Ready for Your Approval';
    const body = `
Detective Anna has calculated the winner. YOUR APPROVAL IS REQUIRED before any emails go out.

PROPOSED WINNER
────────────────
Team: ${winner.team_name}
Captain: ${winner.captain_name} (${winner.captain_email})
School: ${winner.school_name}
Total Score: ${winner.total_score} pts
Correct Accusation: ${winner.correct_accusation ? 'YES ✓' : 'NO ✗'}

TOP 5 LEADERBOARD
────────────────
${leaderboard.join('\n')}

TO APPROVE: Log in to the admin panel at https://www.topkpop.io/pages/admin
Scroll to the “Winner Approval” section and click “Approve & Send Winner Email”.

Do NOT approve until you have reviewed all scores and are satisfied with the result.
    `;

    // Use Mailchimp tag to notify admin (or send via transactional email if configured)
    await tagSubscriber(adminEmail, 'winner-pending-admin-approval');
    console.log(`Admin notified of pending winner approval: ${winner.team_name}`);
    console.log('ADMIN NOTIFICATION BODY:\n' + body);
  } catch (err) {
    console.error('Admin notification error:', err);
  }
}

// ── Admin: Approve winner and send final emails ───────────────────────────────
router.post('/admin/approve-winner', adminAuth, async (req, res) => {
  try {
    const { data: settings } = await supabase
      .from('game_settings')
      .select('winner_pending_approval, winner_team_id, winner_data, winner_announced')
      .eq('id', 1)
      .single();

    if (!settings?.winner_pending_approval) {
      return res.status(400).json({ error: 'No winner is pending approval.' });
    }
    if (settings?.winner_announced) {
      return res.status(400).json({ error: 'Winner has already been announced.' });
    }

    const winner = JSON.parse(settings.winner_data || '{}');
    if (!winner.captain_email) {
      return res.status(400).json({ error: 'Winner data is missing or corrupted.' });
    }

    // Mark winner in registrations
    await supabase.from('registrations').update({ status: 'winner' }).eq('id', settings.winner_team_id);

    // Mark as officially announced
    await supabase.from('game_settings').update({
      winner_announced: true,
      winner_pending_approval: false,
      prize_email_sent: true,
    }).eq('id', 1);

    // Tag winner in Mailchimp — triggers winner automation
    await tagSubscriber(winner.captain_email, 'winner');
    await tagSubscriber(winner.captain_email, 'winner-address-needed');

    // Tag all participants as game-complete
    const { data: allTeams } = await supabase.from('registrations').select('captain_email');
    for (const t of allTeams || []) {
      await tagSubscriber(t.captain_email, 'game-complete');
    }

    console.log(`Winner APPROVED and announced by admin: ${winner.team_name} (${winner.captain_email})`);
    res.json({
      success: true,
      message: `Winner announced: ${winner.team_name}. All emails sent.`,
      winner,
    });
  } catch (err) {
    console.error('Approve winner error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// ── Fuzzy Saboteur Match ────────────────────────────────────────────────────
// Accepts misspellings, partial names, and case variations.
// e.g. "emilise", "Emilese", "Emilis", "emilise park" all match "Emilise"
function fuzzyMatchSaboteur(guess, correct) {
  if (!guess || !correct) return false;
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const g = normalize(guess);
  const c = normalize(correct);
  if (g === c) return true;
  if (g.includes(c) || c.includes(g)) return true;
  // Levenshtein distance for short names (<=12 chars) — allows 1-2 char typos
  if (c.length <= 12) {
    function lev(a, b) {
      const m = a.length, n = b.length;
      const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
      return dp[m][n];
    }
    const dist = lev(g, c);
    const maxDist = c.length <= 6 ? 1 : 2; // 1 typo for short names, 2 for longer
    if (dist <= maxDist) return true;
  }
  // Word overlap: any word in guess matches any word in correct
  const gWords = g.split(' ');
  const cWords = c.split(' ');
  for (const gw of gWords) {
    for (const cw of cWords) {
      if (gw.length >= 4 && cw.length >= 4 && (gw.includes(cw) || cw.includes(gw))) return true;
    }
  }
  return false;
}

// Middleware: check admin password
function adminAuth(req, res, next) {
  const { password } = req.headers;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

// Get all registrations
router.get('/admin/registrations', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('registrations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// Get all submissions
router.get('/admin/submissions', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// Get all accusations
router.get('/admin/accusations', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('accusations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// Update score for a submission
router.post('/admin/score', adminAuth, async (req, res) => {
  const { submission_id, score } = req.body;
  if (!submission_id || score === undefined) {
    return res.status(400).json({ error: 'submission_id and score required.' });
  }
  const { data, error } = await supabase
    .from('submissions')
    .update({ admin_score: parseInt(score), final_score: parseInt(score), scored_at: new Date().toISOString() })
    .eq('id', submission_id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// ── Award Instagram Bonus Points ────────────────────────────────────────────
// POST /api/admin/award-bonus
// Body: { submission_id, bonus_points, instagram_post_url, awarded_by }
router.post('/admin/award-bonus', adminAuth, async (req, res) => {
  const { submission_id, bonus_points, instagram_post_url, awarded_by } = req.body;
  if (!submission_id || bonus_points === undefined) {
    return res.status(400).json({ error: 'submission_id and bonus_points required.' });
  }
  const pts = parseInt(bonus_points);
  if (isNaN(pts) || pts < 0 || pts > 100) {
    return res.status(400).json({ error: 'bonus_points must be a number between 0 and 100.' });
  }

  const updatePayload = {
    bonus_score: pts,
    bonus_awarded_at: new Date().toISOString(),
    bonus_awarded_by: awarded_by || 'admin',
  };
  if (instagram_post_url) updatePayload.instagram_post_url = instagram_post_url;

  const { data, error } = await supabase
    .from('submissions')
    .update(updatePayload)
    .eq('id', submission_id)
    .select('id, team_id, team_name, trove_number, final_score, bonus_score, instagram_post_url, bonus_awarded_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Log the bonus award
  console.log(`[BONUS] ${pts} pts awarded to submission ${submission_id} (${data.team_name} Trove ${data.trove_number}) by ${awarded_by || 'admin'}`);

  res.json({ success: true, data, message: `+${pts} bonus points awarded to ${data.team_name} for Trove ${data.trove_number}.` });
});

// ── Get pending Instagram bonus submissions ──────────────────────────────────
// GET /api/admin/instagram-pending
// Returns submissions that have instagram_post_url but no bonus_score yet
router.get('/admin/instagram-pending', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('submissions')
      .select('id, team_id, team_name, trove_number, final_score, bonus_score, instagram_post_url, bonus_awarded_at, created_at')
      .not('instagram_post_url', 'is', null)
      .neq('instagram_post_url', '')
      .order('created_at', { ascending: false });
    if (error) throw error;
    // Separate pending (no bonus yet) from awarded
    const pending = (data || []).filter(s => !s.bonus_score || s.bonus_score === 0);
    const awarded = (data || []).filter(s => s.bonus_score && s.bonus_score > 0);
    res.json({ success: true, pending, awarded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public game settings — returns unlock dates for the missions page (no auth required)
router.get('/game-settings', async (req, res) => {
  const { data, error } = await supabase.from('game_settings')
    .select('game_start_date, trove1_unlock, trove2_unlock, trove3_unlock, accusation_open, accusation_close')
    .eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get/update game settings (admin)
router.get('/admin/settings', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('game_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

router.post('/admin/settings', adminAuth, async (req, res) => {
  const allowed = ['game_start_date', 'trove1_unlock', 'trove2_unlock', 'trove3_unlock',
    'accusation_open', 'accusation_close', 'reveal_unlock', 'correct_saboteur'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('game_settings').update(updates).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// ════════════════════════════════════════════════════════════════════════════
// CRON SCHEDULER — Monday morning Trove unlocks
// ════════════════════════════════════════════════════════════════════════════

async function sendTroveUnlockEmail(troveNumber) {
  // Send Trove unlock email directly via Gmail
  const emailMap = {
    1: { file: 'email7_trove01_unlock.html', subject: '🔓 CLASSIFIED DROP: Trove 01 Is Now Open — Identity & Cover' },
    2: { file: 'email8_trove02_unlock.html', subject: '🎵 CLASSIFIED DROP: Trove 02 Is Now Open — The Evidence Song' },
    3: { file: 'email9_trove03_unlock.html', subject: '🕵️ CLASSIFIED DROP: Trove 03 Is Now Open — Teach, Perform, Solve' },
  };
  const emailCfg = emailMap[troveNumber];
  if (!emailCfg) return;
  try {
    const { data: teams } = await supabase
      .from('registrations')
      .select('captain_email, captain_name')
      .eq('status', 'active');

    for (const team of teams || []) {
      const firstName = (team.captain_name || '').split(' ')[0] || 'Detective';
      await sendEmail(emailCfg.file, team.captain_email, emailCfg.subject, { '[CAPTAIN_NAME]': firstName });
      await tagSubscriber(team.captain_email, `trove-${troveNumber}-unlocked`);
    }
    console.log(`Trove ${troveNumber} unlock email sent directly to ${teams?.length || 0} teams`);
  } catch (err) {
    console.error(`Trove ${troveNumber} unlock email error:`, err);
  }
}

// Admin: Re-score a submission with Oracle AI
router.post('/admin/rescore', adminAuth, async (req, res) => {
  const { submission_id } = req.body;
  if (!submission_id) return res.status(400).json({ error: 'submission_id required.' });

  const { data: sub, error: fetchErr } = await supabase
    .from('submissions')
    .select('*')
    .eq('id', submission_id)
    .single();

  if (fetchErr || !sub) return res.status(404).json({ error: 'Submission not found.' });

  const scoringData = {
    team_name: sub.team_name,
    notes: sub.notes,
    text_content: null,
    file1_name: sub.file1_name,
    file2_name: sub.file2_name,
    file3_name: sub.file3_name,
  };

  const oracleResult = await scoreWithOracle(sub.trove_number, scoringData);

  if (!oracleResult.success) {
    return res.status(500).json({ error: 'Oracle scoring failed.', details: oracleResult.error });
  }

  const { data: updated, error: updateErr } = await supabase
    .from('submissions')
    .update({
      oracle_score: oracleResult.score,
      final_score: sub.admin_score || oracleResult.score,
      scored_at: new Date().toISOString(),
    })
    .eq('id', submission_id)
    .select()
    .single();

  if (updateErr) return res.status(500).json({ error: updateErr.message });
  res.json({ success: true, score: oracleResult.score, feedback: oracleResult.feedback, data: updated });
});

// Admin: Get full leaderboard with all scores
router.get('/admin/leaderboard', adminAuth, async (req, res) => {
  try {
    // Fetch registrations, submissions, and accusations separately (avoids FK join issues)
    const { data: teams, error: teamsError } = await supabase
      .from('registrations')
      .select('id, team_name, captain_name, captain_email, school_name, district, status, created_at')
      .order('team_name');
    if (teamsError) throw teamsError;

    const { data: submissions, error: subsError } = await supabase
      .from('submissions')
      .select('id, team_id, trove_number, oracle_score, admin_score, final_score, bonus_score, instagram_post_url, bonus_awarded_at, scored_at, file1_name, file2_name, file3_name, notes, created_at')
      .not('team_id', 'is', null);
    if (subsError) throw subsError;

    const { data: accusations, error: accError } = await supabase
      .from('accusations')
      .select('team_id, accused_suspect, is_correct, accusation_score, created_at')
      .not('team_id', 'is', null);
    if (accError) throw accError;

    // Build maps keyed by team_id
    const subsMap = {};
    (submissions || []).forEach(s => {
      if (!subsMap[s.team_id]) subsMap[s.team_id] = [];
      subsMap[s.team_id].push(s);
    });
    const accMap = {};
    (accusations || []).forEach(a => { accMap[a.team_id] = a; });

    const ranked = (teams || []).map(team => {
      const teamSubs = subsMap[team.id] || [];
      const scores = { trove1: 0, trove2: 0, trove3: 0, bonus: 0 };
      teamSubs.forEach(s => {
        const score = s.final_score || s.oracle_score || 0;
        if (score > 0) scores[`trove${s.trove_number}`] = score;
        scores.bonus += (s.bonus_score || 0);
      });
      const accusationScore = accMap[team.id]?.accusation_score || 0;
      const total = scores.trove1 + scores.trove2 + scores.trove3 + scores.bonus + accusationScore;
      return { ...team, submissions: teamSubs, accusations: accMap[team.id] ? [accMap[team.id]] : [], trove1: scores.trove1, trove2: scores.trove2, trove3: scores.trove3, bonus: scores.bonus, accusation_score: accusationScore, total };
    }).sort((a, b) => b.total - a.total).map((t, i) => ({ ...t, rank: i + 1 }));

    res.json({ success: true, data: ranked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// WEEKLY SCORE SUMMARY EMAIL (Fridays at 5 PM Pacific)
// ════════════════════════════════════════════════════════════════════════════

async function sendWeeklyScoreSummary() {
  try {
    // Fetch registrations and submissions separately (avoids FK join issues)
    const { data: teams } = await supabase
      .from('registrations')
      .select('id, team_name, captain_name, captain_email, status')
      .eq('status', 'active');

    if (!teams || teams.length === 0) return;

    const { data: submissions } = await supabase
      .from('submissions')
      .select('team_id, trove_number, final_score, oracle_score')
      .not('team_id', 'is', null);

    // Build score map keyed by team_id
    const scoreMap = {};
    (submissions || []).forEach(s => {
      if (!scoreMap[s.team_id]) scoreMap[s.team_id] = { trove1: 0, trove2: 0, trove3: 0 };
      const score = s.final_score || s.oracle_score || 0;
      if (score > 0) scoreMap[s.team_id][`trove${s.trove_number}`] = score;
    });

    // Build ranked list for leaderboard position
    const ranked = teams.map(team => {
      const scores = scoreMap[team.id] || { trove1: 0, trove2: 0, trove3: 0 };
      const total = scores.trove1 + scores.trove2 + scores.trove3;
      return { ...team, ...scores, total };
    }).sort((a, b) => b.total - a.total).map((t, i) => ({ ...t, rank: i + 1 }));

    const annaSummaryMessages = [
      "The investigation continues. Here's where things stand — keep pushing, Detective.",
      "Another week in the books. The saboteur is still out there. Your score tells part of the story.",
      "Case status update from Detective Anna Im. Study your numbers. The truth is in the details.",
    ];
    const annaMsg = annaSummaryMessages[Math.floor(Math.random() * annaSummaryMessages.length)];

    for (const team of ranked) {
      const trove1Str = team.trove1 > 0 ? `${team.trove1}/100` : 'Not yet submitted';
      const trove2Str = team.trove2 > 0 ? `${team.trove2}/100` : 'Not yet submitted';
      const trove3Str = team.trove3 > 0 ? `${team.trove3}/100` : 'Not yet submitted';
      const totalStr = team.total > 0 ? `${team.total} points` : '0 points';
      const firstName = (team.captain_name || '').split(' ')[0] || 'Detective';

      // Build weekly summary HTML inline (no separate template file needed)
      const weeklyHtml = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{margin:0;padding:0;background:#0d0d1a;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8e0f0;}
  .wrap{max-width:600px;margin:0 auto;padding:32px 20px;}
  .header{background:linear-gradient(135deg,#1a0533,#0d1a33);border:2px solid #7b2d8b;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;}
  .header h1{color:#f0c040;font-size:22px;margin:0 0 8px;letter-spacing:2px;}
  .header p{color:#b8a8d0;font-size:13px;margin:0;}
  .scores{background:#1a0533;border:1px solid #3d1a5c;border-radius:8px;padding:20px;margin-bottom:20px;}
  .score-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #2d1a4c;}
  .score-row:last-child{border-bottom:none;font-weight:bold;color:#f0c040;font-size:16px;}
  .label{color:#b8a8d0;font-size:14px;}
  .value{color:#e8e0f0;font-size:14px;font-weight:bold;}
  .rank{background:#7b2d8b;color:#fff;border-radius:20px;padding:4px 12px;font-size:13px;display:inline-block;margin-bottom:16px;}
  .anna{background:#0d1a33;border-left:3px solid #f0c040;padding:16px;border-radius:0 8px 8px 0;margin-bottom:20px;font-style:italic;color:#d0c8e8;font-size:14px;}
  .cta{text-align:center;margin:24px 0;}
  .btn{background:linear-gradient(135deg,#7b2d8b,#b8006e);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:15px;display:inline-block;}
  .footer{text-align:center;color:#5a4a6a;font-size:12px;margin-top:24px;}
</style></head><body><div class="wrap">
  <div class="header">
    <h1>📊 WEEKLY CASE FILE UPDATE</h1>
    <p>TopKpop.io Investigation Unit — Confidential Score Report</p>
  </div>
  <p>Detective ${firstName},</p>
  <p>${annaMsg}</p>
  <div class="rank">Current Rank: #${team.rank}</div>
  <div class="scores">
    <div class="score-row"><span class="label">Trove 01 — Identity & Cover</span><span class="value">${trove1Str}</span></div>
    <div class="score-row"><span class="label">Trove 02 — Evidence Song</span><span class="value">${trove2Str}</span></div>
    <div class="score-row"><span class="label">Trove 03 — Teach, Perform, Solve</span><span class="value">${trove3Str}</span></div>
    <div class="score-row"><span class="label">TOTAL SCORE</span><span class="value">${totalStr}</span></div>
  </div>
  <div class="anna">"${annaMsg}" — Detective Anna Im</div>
  <div class="cta"><a href="https://www.topkpop.io/pages/leaderboard" class="btn">View Full Leaderboard</a></div>
  <div class="footer">TopKpop.io Investigation Unit &bull; Fullerton School District &bull; <a href="https://www.topkpop.io" style="color:#7b2d8b;">topkpop.io</a></div>
</div></body></html>`;

      try {
        await gmailTransporter.sendMail({
          from: '"Anna Im — TopKpop.io" <bpletka1@gmail.com>',
          to: team.captain_email,
          subject: `📊 Weekly Case File Update — ${team.team_name} is Ranked #${team.rank}`,
          html: weeklyHtml,
        });
        await tagSubscriber(team.captain_email, 'weekly-score-summary');
      } catch (err) {
        console.error(`Weekly summary error for ${team.captain_email}:`, err.message);
      }
    }

    console.log(`Weekly score summary sent directly to ${ranked.length} teams`);
  } catch (err) {
    console.error('Weekly score summary error:', err);
  }
}

function startScheduler() {
  // ── Sunday 7:00 PM Pacific — Trove / Accusation unlock checks ──────────────
  // Runs every Sunday at 19:00 PT (03:00 UTC Monday)
  cron.schedule('0 3 * * 1', async () => {
    console.log('Scheduler running — Sunday 7pm PT drop check...');
    try {
      const { data: settings } = await supabase
        .from('game_settings')
        .select('*')
        .eq('id', 1)
        .single();

      if (!settings) return;
      const now = new Date();
      const nowISO = now.toISOString();

      // Trove 1 — Day 1 (game start)
      if (settings.game_start_date && settings.game_start_date <= nowISO && !settings.trove1_email_sent) {
        await sendTroveUnlockEmail(1);
        await supabase.from('game_settings').update({ trove1_email_sent: true }).eq('id', 1);
        console.log('Trove 1 unlock email sent.');
      }
      // Trove 2 — Day 8 Sunday 7pm
      if (settings.trove2_unlock && settings.trove2_unlock <= nowISO && !settings.trove2_email_sent) {
        await sendTroveUnlockEmail(2);
        await supabase.from('game_settings').update({ trove2_email_sent: true }).eq('id', 1);
        console.log('Trove 2 unlock email sent.');
      }
      // Trove 3 — Day 15 Sunday 7pm
      if (settings.trove3_unlock && settings.trove3_unlock <= nowISO && !settings.trove3_email_sent) {
        await sendTroveUnlockEmail(3);
        await supabase.from('game_settings').update({ trove3_email_sent: true }).eq('id', 1);
        console.log('Trove 3 unlock email sent.');
      }
      // Guess the Saboteur — Day 22 Sunday 7pm
      if (settings.accusation_open && settings.accusation_open <= nowISO && !settings.accusation_email_sent) {
        await sendAccusationUnlockEmail();
        await supabase.from('game_settings').update({ accusation_email_sent: true }).eq('id', 1);
        console.log('Guess the Saboteur unlock email sent.');
      }
    } catch (err) {
      console.error('Sunday scheduler error:', err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Wednesday midnight Pacific — Final Reveal drop ───────────────────────
  // Runs every Wednesday/Thursday at 00:00 PT (08:00 UTC)
  cron.schedule('0 8 * * 3', async () => {
    console.log('Scheduler running — Final Reveal midnight check...');
    try {
      const { data: settings } = await supabase
        .from('game_settings')
        .select('*')
        .eq('id', 1)
        .single();

      if (!settings) return;
      const nowISO = new Date().toISOString();

      if (settings.reveal_unlock && settings.reveal_unlock <= nowISO && !settings.reveal_email_sent) {
        await sendRevealEmail();
        await supabase.from('game_settings').update({ reveal_email_sent: true }).eq('id', 1);
        console.log('Final Reveal email sent.');
      }
      // Also check winner announcement
      if (settings.accusation_close && settings.accusation_close <= nowISO && !settings.winner_announced) {
        await checkAndAnnounceWinner();
      }
    } catch (err) {
      console.error('Reveal scheduler error:', err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Weekly score summary — every Friday at 5 PM Pacific ───────────────────
  cron.schedule('0 1 * * 6', async () => {
    console.log('Sending weekly score summary emails...');
    await sendWeeklyScoreSummary();
  }, { timezone: 'America/Los_Angeles' });

  // ── Daily 9 AM Pacific — Winner approval reminder ────────────────────────
  // Sends admin a reminder every day at 9 AM PT if a winner is pending approval
  cron.schedule('0 17 * * *', async () => {
    try {
      const { data: settings } = await supabase
        .from('game_settings')
        .select('winner_pending_approval, winner_announced, admin_email')
        .single();
      if (settings?.winner_pending_approval && !settings?.winner_announced) {
        const adminEmail = settings.admin_email || process.env.ADMIN_EMAIL || 'admin@topkpop.io';
        await sendAdminReminderEmail(adminEmail);
        console.log('Winner approval reminder sent to admin.');
      }
    } catch (err) {
      console.error('Winner reminder cron error:', err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Gmail polling — every 30 minutes, check for forwarded score emails ────────────────────────
  // Looks for emails with subject containing "scores" or "dance" or "joyce"
  // forwarded to the admin inbox, and auto-applies scores via score-by-name logic
  cron.schedule('*/30 * * * *', async () => {
    await pollGmailForScores();
  });

  console.log('TopKpop.io scheduler started — Trove drops Sundays 7PM PT | Reveal Wednesdays midnight PT | Summaries Fridays 5PM PT | Winner reminders daily 9AM PT | Gmail score polling every 30 min');
}

// ── Helper: Send admin reminder email for pending winner approval ────────────
async function sendAdminReminderEmail(adminEmail) {
  try {
    // Get winner details for the reminder
    const { data: settings } = await supabase
      .from('game_settings')
      .select('winner_team_name, winner_captain_email, winner_total_score, winner_accusation_correct')
      .single();

    const teamName = settings?.winner_team_name || 'Unknown Team';
    const score = settings?.winner_total_score || 0;
    const correct = settings?.winner_accusation_correct ? 'YES — correct accusation' : 'NO — incorrect accusation';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{margin:0;padding:0;background:#0d0d1a;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8e0f0;}
      .wrap{max-width:600px;margin:0 auto;padding:32px 20px;}
      .box{background:#1a0533;border:2px solid #f0c040;border-radius:12px;padding:24px;margin-bottom:20px;}
      h2{color:#f0c040;margin:0 0 16px;}
      .row{padding:8px 0;border-bottom:1px solid #2d1a4c;display:flex;justify-content:space-between;}
      .row:last-child{border-bottom:none;}
      .label{color:#b8a8d0;font-size:14px;}
      .value{color:#e8e0f0;font-size:14px;font-weight:bold;}
      .btn{display:inline-block;background:linear-gradient(135deg,#7b2d8b,#b8006e);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;margin-top:20px;}
    </style></head><body><div class="wrap">
      <div class="box">
        <h2>🏆 Winner Ready for Approval</h2>
        <div class="row"><span class="label">Team</span><span class="value">${teamName}</span></div>
        <div class="row"><span class="label">Total Score</span><span class="value">${score} pts</span></div>
        <div class="row"><span class="label">Accusation</span><span class="value">${correct}</span></div>
        <a href="https://www.topkpop.io/pages/admin" class="btn">Go to Admin Dashboard →</a>
      </div>
    </div></body></html>`;

    await gmailTransporter.sendMail({
      from: '"TopKpop.io System" <bpletka1@gmail.com>',
      to: adminEmail,
      subject: `🏆 ACTION REQUIRED: Winner Ready for Approval — ${teamName}`,
      html,
    });
    console.log(`Admin reminder sent to ${adminEmail}: winner "${teamName}" (${score} pts, accusation: ${correct}) awaiting approval`);
  } catch (err) {
    console.error('Admin reminder email error:', err);
  }
}

// ── Helper: Send Guess the Saboteur unlock email ─────────────────────────────
async function sendAccusationUnlockEmail() {
  try {
    const { data: teams } = await supabase
      .from('registrations')
      .select('captain_email, captain_name')
      .eq('status', 'active');
    for (const team of teams || []) {
      const firstName = (team.captain_name || '').split(' ')[0] || 'Detective';
      await sendEmail(
        'email10_accusation_open.html',
        team.captain_email,
        '🚨 FINAL ACCUSATION WINDOW OPEN — Who Is the Saboteur?',
        { '[CAPTAIN_NAME]': firstName }
      );
      await tagSubscriber(team.captain_email, 'accusation-unlocked');
    }
    console.log(`Accusation unlock email sent directly to ${teams?.length || 0} teams`);
  } catch (err) {
    console.error('Accusation unlock email error:', err);
  }
}

// ── Helper: Send Final Reveal email ──────────────────────────────────────────
async function sendRevealEmail() {
  try {
    const { data: settings } = await supabase
      .from('game_settings')
      .select('correct_saboteur, winner_team_name, winner_total_score')
      .eq('id', 1)
      .single();

    const saboteur = settings?.correct_saboteur || 'The Saboteur';
    const winnerName = settings?.winner_team_name || 'The Winning Team';
    const winnerScore = settings?.winner_total_score || '—';

    const { data: teams } = await supabase
      .from('registrations')
      .select('captain_email, captain_name')
      .eq('status', 'active');

    for (const team of teams || []) {
      const firstName = (team.captain_name || '').split(' ')[0] || 'Detective';
      await sendEmail(
        'email6_winner.html',
        team.captain_email,
        '🎤 CASE CLOSED — The Saboteur Has Been Unmasked',
        {
          '[CAPTAIN_NAME]': firstName,
          '[SABOTEUR_NAME]': saboteur,
          '[WINNING_TEAM_NAME]': winnerName,
          '[SCORE]': String(winnerScore),
        }
      );
      await tagSubscriber(team.captain_email, 'final-reveal-live');
    }
    console.log(`Final Reveal email sent directly to ${teams?.length || 0} teams`);
  } catch (err) {
    console.error('Final Reveal email error:', err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SCORE BY NAME — Parse free-text scores (Joyce email, Instagram, etc.)
// POST /api/admin/score-by-name
// Body: { text, trove_number, score_type }
//   text: raw email body or free text like "Team Alpha: 87, Team Beta: 92"
//   trove_number: 1, 2, or 3 (which trove these scores are for)
//   score_type: 'dance' | 'bonus' | 'admin' (default: 'admin')
// ════════════════════════════════════════════════════════════════════════════

router.post('/admin/score-by-name', adminAuth, async (req, res) => {
  try {
    const { text, trove_number, score_type = 'admin' } = req.body;
    if (!text || !trove_number) {
      return res.status(400).json({ error: 'text and trove_number are required.' });
    }
    const troveNum = parseInt(trove_number);
    if (![1, 2, 3].includes(troveNum)) {
      return res.status(400).json({ error: 'trove_number must be 1, 2, or 3.' });
    }

    // ── Parse team name + score pairs from free text ──────────────────────────
    // Supports many formats:
    //   "Team Alpha: 87"  |  "Team Alpha - 87"  |  "Team Alpha = 87"
    //   "Team Alpha 87/100"  |  "Team Alpha scored 87"  |  "87 - Team Alpha"
    //   "Team Alpha: 87 pts"  |  "Team Alpha (87)"  |  "Team Alpha: 87 points"
    const lines = text.split(/[\n,;]+/).map(l => l.trim()).filter(Boolean);
    const parsed = [];

    for (const line of lines) {
      // Pattern 1: "Name: 87" or "Name - 87" or "Name = 87" or "Name (87)" or "Name 87pts"
      let m = line.match(/^(.+?)\s*[:\-=]\s*(\d{1,3})(?:\s*(?:\/100|pts?|points?)?)?\s*$/i);
      if (!m) {
        // Pattern 2: "Name scored 87" or "Name received 87"
        m = line.match(/^(.+?)\s+(?:scored?|received?|gets?|awarded?)\s+(\d{1,3})(?:\s*(?:\/100|pts?|points?)?)?\s*$/i);
      }
      if (!m) {
        // Pattern 3: "87 - Name" or "87: Name" (score first)
        m = line.match(/^(\d{1,3})\s*[:\-]\s*(.+)$/);
        if (m) m = [m[0], m[2], m[1]]; // swap so name is [1], score is [2]
      }
      if (!m) {
        // Pattern 4: "Name (87)" or "Name [87]"
        m = line.match(/^(.+?)\s*[\(\[](\d{1,3})[\)\]]\s*$/);
      }
      if (m) {
        const name = m[1].trim().replace(/^["'\s]+|["'\s]+$/g, '');
        const score = parseInt(m[2]);
        if (name && !isNaN(score) && score >= 0 && score <= 100) {
          parsed.push({ name, score });
        }
      }
    }

    if (parsed.length === 0) {
      return res.status(400).json({
        error: 'No team scores could be parsed from the text. Use format: "Team Name: 87" or "Team Name - 92 pts" (one per line).',
        hint: 'Each line should have a team name and a number 0-100. Separate entries with new lines or commas.',
      });
    }

    // ── Fetch all team names from registrations ───────────────────────────────
    const { data: allTeams, error: teamsErr } = await supabase
      .from('registrations')
      .select('id, team_name');
    if (teamsErr) throw teamsErr;

    // ── Fetch existing submissions for this trove ─────────────────────────────
    const { data: existingSubs } = await supabase
      .from('submissions')
      .select('id, team_id, team_name, trove_number, final_score, admin_score, bonus_score')
      .eq('trove_number', troveNum);

    const subByTeamId = {};
    (existingSubs || []).forEach(s => { subByTeamId[s.team_id] = s; });

    // ── Fuzzy-match parsed names to registered teams ──────────────────────────
    function normalize(str) {
      return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    }
    function similarity(a, b) {
      const na = normalize(a), nb = normalize(b);
      if (na === nb) return 1.0;
      if (na.includes(nb) || nb.includes(na)) return 0.85;
      // Word overlap score
      const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '));
      const intersection = [...wa].filter(w => wb.has(w)).length;
      const union = new Set([...wa, ...wb]).size;
      return union > 0 ? intersection / union : 0;
    }

    const results = [];
    const errors = [];

    for (const { name, score } of parsed) {
      // Find best matching team
      let bestTeam = null, bestScore = 0;
      for (const team of allTeams) {
        const sim = similarity(name, team.team_name);
        if (sim > bestScore) { bestScore = sim; bestTeam = team; }
      }

      if (!bestTeam || bestScore < 0.4) {
        errors.push({ name, score, error: `No matching team found for "${name}" (closest: ${bestTeam?.team_name || 'none'})` });
        continue;
      }

      const existingSub = subByTeamId[bestTeam.id];

      if (score_type === 'bonus') {
        // Award as bonus points — update or create submission
        if (existingSub) {
          const { error: updateErr } = await supabase
            .from('submissions')
            .update({
              bonus_score: score,
              bonus_awarded_at: new Date().toISOString(),
              bonus_awarded_by: 'score-by-name',
            })
            .eq('id', existingSub.id);
          if (updateErr) { errors.push({ name, score, error: updateErr.message }); continue; }
        } else {
          // Create a placeholder submission for bonus points
          const { error: insertErr } = await supabase
            .from('submissions')
            .insert({
              team_id: bestTeam.id,
              team_name: bestTeam.team_name,
              trove_number: troveNum,
              bonus_score: score,
              bonus_awarded_at: new Date().toISOString(),
              bonus_awarded_by: 'score-by-name',
            });
          if (insertErr) { errors.push({ name, score, error: insertErr.message }); continue; }
        }
        results.push({ matched_team: bestTeam.team_name, input_name: name, score, score_type: 'bonus', confidence: Math.round(bestScore * 100) });

      } else {
        // Award as admin/dance score — updates final_score
        if (existingSub) {
          const { error: updateErr } = await supabase
            .from('submissions')
            .update({
              admin_score: score,
              final_score: score,
              scored_at: new Date().toISOString(),
            })
            .eq('id', existingSub.id);
          if (updateErr) { errors.push({ name, score, error: updateErr.message }); continue; }
        } else {
          // Create a placeholder submission with the admin score
          const { error: insertErr } = await supabase
            .from('submissions')
            .insert({
              team_id: bestTeam.id,
              team_name: bestTeam.team_name,
              trove_number: troveNum,
              admin_score: score,
              final_score: score,
              scored_at: new Date().toISOString(),
            });
          if (insertErr) { errors.push({ name, score, error: insertErr.message }); continue; }
        }
        results.push({ matched_team: bestTeam.team_name, input_name: name, score, score_type, confidence: Math.round(bestScore * 100) });
      }
    }

    console.log(`[SCORE-BY-NAME] Trove ${troveNum} (${score_type}): ${results.length} scored, ${errors.length} errors`);
    res.json({
      success: true,
      scored: results.length,
      errors: errors.length,
      results,
      parse_errors: errors,
      message: `${results.length} team(s) scored successfully.${errors.length > 0 ? ` ${errors.length} could not be matched — check names.` : ''}`,
    });

  } catch (err) {
    console.error('Score-by-name error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GMAIL SCORE POLLING
// Checks Gmail every 30 min for forwarded score emails from Joyce or admin.
// Emails must have subject containing: score, dance, joyce, bonus, or instagram
// Body format: "Team Name: 87" or "Team Name - 92 pts" (one per line)
// Trove is detected from subject: "trove 1", "trove 2", "trove 3"
// Score type is detected: "dance" → admin score, "bonus"/"instagram" → bonus score
// Processed emails are labeled "topkpop-scored" to prevent re-processing
// ════════════════════════════════════════════════════════════════════════════

async function pollGmailForScores() {
  try {
    // Use the manus-mcp-cli to search Gmail for unprocessed score emails
    const { execSync } = require('child_process');

    // Search for emails with score-related subjects not yet labeled topkpop-scored
    const searchQuery = JSON.stringify({
      q: '(subject:score OR subject:dance OR subject:joyce OR subject:bonus OR subject:instagram) -label:topkpop-scored',
      max_results: 20,
    });

    let searchResult;
    try {
      const raw = execSync(
        `manus-mcp-cli tool call gmail_search_messages --server gmail --input '${searchQuery.replace(/'/g, "'\"'\"'")}'`,
        { timeout: 30000, encoding: 'utf8' }
      );
      searchResult = JSON.parse(raw);
    } catch (e) {
      // Gmail MCP not available in this environment — skip silently
      return;
    }

    const messages = searchResult?.messages || searchResult?.result?.messages || [];
    if (!messages.length) return;

    console.log(`[GMAIL POLL] Found ${messages.length} potential score email(s)`);

    for (const msg of messages) {
      try {
        // Read the full thread
        const threadRaw = execSync(
          `manus-mcp-cli tool call gmail_read_threads --server gmail --input '${JSON.stringify({ thread_ids: [msg.threadId || msg.id], include_full_messages: true }).replace(/'/g, "'\"'\"'")}'`,
          { timeout: 30000, encoding: 'utf8' }
        );
        const threadResult = JSON.parse(threadRaw);
        const thread = (threadResult?.threads || threadResult?.result?.threads || [])[0];
        if (!thread) continue;

        const firstMsg = thread.messages?.[0];
        if (!firstMsg) continue;

        const subject = (firstMsg.subject || firstMsg.headers?.subject || '').toLowerCase();
        const body = firstMsg.body || firstMsg.snippet || '';

        // Detect trove number from subject
        let troveNum = null;
        if (/trove[\s-]?3|trove[\s-]?03/.test(subject)) troveNum = 3;
        else if (/trove[\s-]?2|trove[\s-]?02/.test(subject)) troveNum = 2;
        else if (/trove[\s-]?1|trove[\s-]?01/.test(subject)) troveNum = 1;
        else troveNum = 3; // Default to Trove 3 (most likely Joyce dance scores)

        // Detect score type
        const scoreType = /bonus|instagram/.test(subject) ? 'bonus' : 'admin';

        // Parse scores from body using same logic as score-by-name endpoint
        const lines = body.split(/[\n,;]+/).map(l => l.trim()).filter(Boolean);
        const parsed = [];
        for (const line of lines) {
          let m = line.match(/^(.+?)\s*[:\-=]\s*(\d{1,3})(?:\s*(?:\/100|pts?|points?)?)?\s*$/i);
          if (!m) m = line.match(/^(.+?)\s+(?:scored?|received?|gets?|awarded?)\s+(\d{1,3})(?:\s*(?:\/100|pts?|points?)?)?\s*$/i);
          if (!m) {
            const sm = line.match(/^(\d{1,3})\s*[:\-]\s*(.+)$/);
            if (sm) m = [sm[0], sm[2], sm[1]];
          }
          if (!m) m = line.match(/^(.+?)\s*[\(\[](\d{1,3})[\)\]]\s*$/);
          if (m) {
            const name = m[1].trim().replace(/^["'\s]+|["'\s]+$/g, '');
            const score = parseInt(m[2]);
            if (name && !isNaN(score) && score >= 0 && score <= 100) parsed.push({ name, score });
          }
        }

        if (parsed.length === 0) {
          console.log(`[GMAIL POLL] No parseable scores in email: "${subject}" — skipping`);
          continue;
        }

        // Fetch teams and submissions
        const { data: allTeams } = await supabase.from('registrations').select('id, team_name');
        const { data: existingSubs } = await supabase.from('submissions').select('id, team_id, team_name, trove_number, final_score, admin_score, bonus_score').eq('trove_number', troveNum);
        const subByTeamId = {};
        (existingSubs || []).forEach(s => { subByTeamId[s.team_id] = s; });

        function normalize(str) { return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim(); }
        function similarity(a, b) {
          const na = normalize(a), nb = normalize(b);
          if (na === nb) return 1.0;
          if (na.includes(nb) || nb.includes(na)) return 0.85;
          const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '));
          const intersection = [...wa].filter(w => wb.has(w)).length;
          const union = new Set([...wa, ...wb]).size;
          return union > 0 ? intersection / union : 0;
        }

        let applied = 0;
        for (const { name, score } of parsed) {
          let bestTeam = null, bestScore = 0;
          for (const team of (allTeams || [])) {
            const sim = similarity(name, team.team_name);
            if (sim > bestScore) { bestScore = sim; bestTeam = team; }
          }
          if (!bestTeam || bestScore < 0.4) {
            console.log(`[GMAIL POLL] No team match for "${name}" (best: ${bestTeam?.team_name}, sim: ${bestScore.toFixed(2)})`);
            continue;
          }
          const existingSub = subByTeamId[bestTeam.id];
          if (scoreType === 'bonus') {
            if (existingSub) {
              await supabase.from('submissions').update({ bonus_score: score, bonus_awarded_at: new Date().toISOString(), bonus_awarded_by: 'gmail-auto' }).eq('id', existingSub.id);
            } else {
              await supabase.from('submissions').insert({ team_id: bestTeam.id, team_name: bestTeam.team_name, trove_number: troveNum, bonus_score: score, bonus_awarded_at: new Date().toISOString(), bonus_awarded_by: 'gmail-auto' });
            }
          } else {
            if (existingSub) {
              await supabase.from('submissions').update({ admin_score: score, final_score: score, scored_at: new Date().toISOString() }).eq('id', existingSub.id);
            } else {
              await supabase.from('submissions').insert({ team_id: bestTeam.id, team_name: bestTeam.team_name, trove_number: troveNum, admin_score: score, final_score: score, scored_at: new Date().toISOString() });
            }
          }
          applied++;
          console.log(`[GMAIL POLL] Applied ${scoreType} score ${score} to ${bestTeam.team_name} (Trove ${troveNum}) from email "${subject}"`);
        }

        // Label the email as processed so it won't be re-processed
        if (applied > 0) {
          try {
            execSync(
              `manus-mcp-cli tool call gmail_manage_labels --server gmail --input '${JSON.stringify({ action: 'apply', message_ids: [msg.id], label_names: ['topkpop-scored'] }).replace(/'/g, "'\"'\"'")}'`,
              { timeout: 15000, encoding: 'utf8' }
            );
          } catch (labelErr) {
            console.log('[GMAIL POLL] Could not apply label (non-fatal):', labelErr.message);
          }
          console.log(`[GMAIL POLL] Processed email "${subject}" — ${applied} score(s) applied`);
        }

      } catch (msgErr) {
        console.error('[GMAIL POLL] Error processing message:', msgErr.message);
      }
    }
  } catch (err) {
    console.error('[GMAIL POLL] Poll error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// NEW GAME INSTANCE
// POST /api/admin/new-game-instance
// Resets schedule, winner state, and email-sent flags for a fresh game run.
// Does NOT delete teams or submissions — history is preserved.
// Requires: { game_start_date, correct_saboteur, confirm: 'START NEW GAME' }
// ════════════════════════════════════════════════════════════════════════════

router.post('/admin/new-game-instance', adminAuth, async (req, res) => {
  try {
    const { game_start_date, correct_saboteur, confirm } = req.body;

    // Safety confirmation — must type exactly "START NEW GAME"
    if (confirm !== 'START NEW GAME') {
      return res.status(400).json({
        error: 'Confirmation required. Send { confirm: "START NEW GAME" } to proceed.',
      });
    }

    if (!game_start_date) {
      return res.status(400).json({ error: 'game_start_date is required.' });
    }

    const start = new Date(game_start_date);
    if (isNaN(start.getTime())) {
      return res.status(400).json({ error: 'Invalid game_start_date.' });
    }

    // Auto-calculate schedule from start date
    function nextSunday7pm(baseDate, daysOffset) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + daysOffset);
      // Snap to Sunday if not already
      const dow = d.getDay(); // 0=Sun
      if (dow !== 0) d.setDate(d.getDate() + (7 - dow));
      d.setHours(19, 0, 0, 0); // 7pm
      return d.toISOString();
    }

    const trove2Unlock    = nextSunday7pm(start, 7);   // Day 8 Sunday
    const trove3Unlock    = nextSunday7pm(start, 14);  // Day 15 Sunday
    const accusationOpen  = nextSunday7pm(start, 21);  // Day 22 Sunday
    const accusationClose = new Date(new Date(accusationOpen).getTime() + 48 * 60 * 60 * 1000).toISOString(); // +48h
    const revealUnlock    = new Date(new Date(start).setDate(start.getDate() + 24)); // Day 25 midnight
    revealUnlock.setHours(0, 0, 0, 0);

    const resetData = {
      game_start_date:        start.toISOString().slice(0, 10),
      trove1_unlock:          start.toISOString().slice(0, 10),
      trove2_unlock:          trove2Unlock,
      trove3_unlock:          trove3Unlock,
      accusation_open:        accusationOpen,
      accusation_close:       accusationClose,
      reveal_unlock:          revealUnlock.toISOString(),
      correct_saboteur:       correct_saboteur || null,
      // Reset all email-sent flags
      trove1_email_sent:      false,
      trove2_email_sent:      false,
      trove3_email_sent:      false,
      accusation_email_sent:  false,
      // Reset winner state
      winner_announced:       false,
      winner_pending_approval: false,
      winner_team_id:         null,
      winner_team_name:       null,
      winner_captain_email:   null,
      winner_total_score:     null,
      winner_accusation_correct: null,
      winner_data:            null,
      prize_email_sent:       false,
      updated_at:             new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('game_settings')
      .update(resetData)
      .eq('id', 1)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    console.log(`[NEW GAME INSTANCE] Started: ${game_start_date}, Saboteur: ${correct_saboteur || '(not set)'}`);

    res.json({
      success: true,
      message: 'New game instance started. Schedule auto-calculated. Winner state and email flags reset. Team registrations and submissions preserved.',
      schedule: {
        game_start_date:  resetData.game_start_date,
        trove2_unlock:    trove2Unlock,
        trove3_unlock:    trove3Unlock,
        accusation_open:  accusationOpen,
        accusation_close: accusationClose,
        reveal_unlock:    revealUnlock.toISOString(),
      },
      correct_saboteur: correct_saboteur || '(not set — update separately)',
    });

  } catch (err) {
    console.error('[NEW GAME INSTANCE] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, startScheduler };
