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
      member4_name, member4_email, agree_terms, agree_iste
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

    // Add to Mailchimp
    const nameParts = captain_name.trim().split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || '';
    const mcAdded = await addToMailchimp(captain_email.toLowerCase(), firstName, lastName, ['registered', 'trove-01-pending']);

    // Mark welcome sent
    if (mcAdded) {
      await supabase.from('registrations').update({ welcome_sent: true }).eq('id', reg.id);
    }

    // Also add team members to Mailchimp
    const members = [
      { name: member2_name, email: member2_email },
      { name: member3_name, email: member3_email },
      { name: member4_name, email: member4_email },
    ].filter(m => m.name && m.email);

    for (const member of members) {
      const parts = member.name.trim().split(' ');
      await addToMailchimp(member.email.toLowerCase(), parts[0], parts.slice(1).join(' ') || '', ['registered', 'team-member']);
    }

    res.json({
      success: true,
      message: `Welcome to the investigation, ${team_name}! Check your email for your mission briefing.`,
      team_id: reg.id,
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

  const isCorrect = settings?.correct_saboteur &&
    accused_suspect.toLowerCase().trim() === settings.correct_saboteur.toLowerCase().trim();
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

    const { team_name, captain_email, notes } = req.body;

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

    // Upsert submission (allow resubmission before scoring)
    const { data: sub, error: subError } = await supabase
      .from('submissions')
      .upsert({
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
      }, { onConflict: 'team_id,trove_number' })
      .select()
      .single();

    if (subError) throw subError;

    // Tag in Mailchimp
    await tagSubscriber(captain_email.toLowerCase(), `trove-${troveNumber}-submitted`);

    // ── Oracle AI Scoring ────────────────────────────────────────────────────
    const scoringData = {
      team_name: team_name.trim(),
      notes: notes?.trim(),
      text_content: req.body.text_content?.trim() || req.body.lyrics?.trim() || req.body.lesson_plan?.trim() || null,
      file1_name: file1Data?.name,
      file2_name: file2Data?.name,
      file3_name: file3Data?.name,
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
      .select('team_id, trove_number, final_score, oracle_score')
      .not('team_id', 'is', null);
    if (subsError) throw subsError;

    // Build score map keyed by team_id
    const scoreMap = {};
    (submissions || []).forEach(s => {
      if (!scoreMap[s.team_id]) scoreMap[s.team_id] = { trove1: 0, trove2: 0, trove3: 0 };
      const score = s.final_score || s.oracle_score || 0;
      if (score > 0) scoreMap[s.team_id][`trove${s.trove_number}`] = score;
    });

    // Calculate totals and rank
    const ranked = (teams || []).map(team => {
      const scores = scoreMap[team.id] || { trove1: 0, trove2: 0, trove3: 0 };
      const total = scores.trove1 + scores.trove2 + scores.trove3;
      return {
        team_name: team.team_name,
        school_name: team.school_name,
        district: team.district,
        trove1: scores.trove1,
        trove2: scores.trove2,
        trove3: scores.trove3,
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
    const isCorrect = settings?.correct_saboteur &&
      accused_suspect.toLowerCase().trim() === settings.correct_saboteur.toLowerCase().trim();
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

    // Mark winner
    await supabase.from('registrations').update({ status: 'winner' }).eq('id', winner.id);
    await supabase.from('game_settings').update({
      winner_announced: true,
      winner_team_id: winner.id,
    }).eq('id', 1);

    // Tag winner in Mailchimp + send prize fulfillment email
    await tagSubscriber(winner.captain_email, 'winner');

    // Send prize fulfillment email to winner asking for mailing address
    await sendPrizeFulfillmentEmail(winner);

    // Tag all participants as game-complete
    const { data: allTeams } = await supabase.from('registrations').select('captain_email');
    for (const t of allTeams || []) {
      await tagSubscriber(t.captain_email, 'game-complete');
    }

    console.log(`Winner announced: ${winner.team_name} (${winner.captain_email})`);

  } catch (err) {
    console.error('Winner check error:', err);
  }
}

async function sendPrizeFulfillmentEmail(winner) {
  // This sends an automated email to the winner asking for their mailing address
  // Uses Mailchimp tag "winner-address-needed" which triggers an automation
  try {
    await tagSubscriber(winner.captain_email, 'winner-address-needed');
    await supabase.from('game_settings').update({ prize_email_sent: true }).eq('id', 1);
    console.log(`Prize fulfillment email triggered for: ${winner.captain_email}`);
  } catch (err) {
    console.error('Prize email error:', err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

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
  // Tag all registered subscribers with the trove unlock tag
  // This triggers the corresponding Mailchimp automation
  try {
    const { data: teams } = await supabase
      .from('registrations')
      .select('captain_email')
      .eq('status', 'active');

    for (const team of teams || []) {
      await tagSubscriber(team.captain_email, `trove-${troveNumber}-unlocked`);
    }
    console.log(`Tagged ${teams?.length || 0} teams with trove-${troveNumber}-unlocked`);
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
      .select('id, team_id, trove_number, oracle_score, admin_score, final_score, scored_at, file1_name, file2_name, file3_name, notes, created_at')
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
      const scores = { trove1: 0, trove2: 0, trove3: 0 };
      teamSubs.forEach(s => {
        const score = s.final_score || s.oracle_score || 0;
        if (score > 0) scores[`trove${s.trove_number}`] = score;
      });
      const accusationScore = accMap[team.id]?.accusation_score || 0;
      const total = scores.trove1 + scores.trove2 + scores.trove3 + accusationScore;
      return { ...team, submissions: teamSubs, accusations: accMap[team.id] ? [accMap[team.id]] : [], trove1: scores.trove1, trove2: scores.trove2, trove3: scores.trove3, accusation_score: accusationScore, total };
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

      // Tag subscriber with weekly summary tag — triggers Mailchimp automation
      // Store score data as merge fields for the email template
      try {
        const hash = require('crypto').createHash('md5').update(team.captain_email.toLowerCase()).digest('hex');
        await mailchimp.lists.updateListMember(AUDIENCE_ID, hash, {
          merge_fields: {
            TROVE1SC: trove1Str,
            TROVE2SC: trove2Str,
            TROVE3SC: trove3Str,
            TOTALSC: totalStr,
            RANK: `#${team.rank}`,
            ANNAMSG: annaMsg,
          },
        });
        await tagSubscriber(team.captain_email, 'weekly-score-summary');
      } catch (err) {
        console.error(`Weekly summary error for ${team.captain_email}:`, err.message);
      }
    }

    console.log(`Weekly score summary sent to ${ranked.length} teams`);
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

  console.log('TopKpop.io scheduler started — Trove drops Sundays 7PM PT | Reveal Wednesdays midnight PT | Summaries Fridays 5PM PT');
}

// ── Helper: Send Guess the Saboteur unlock email ─────────────────────────────
async function sendAccusationUnlockEmail() {
  try {
    const { data: teams } = await supabase
      .from('registrations')
      .select('captain_email')
      .eq('status', 'active');
    for (const team of teams || []) {
      await tagSubscriber(team.captain_email, 'accusation-unlocked');
    }
    console.log(`Tagged ${teams?.length || 0} teams with accusation-unlocked`);
  } catch (err) {
    console.error('Accusation unlock email error:', err);
  }
}

// ── Helper: Send Final Reveal email ──────────────────────────────────────────
async function sendRevealEmail() {
  try {
    const { data: teams } = await supabase
      .from('registrations')
      .select('captain_email')
      .eq('status', 'active');
    for (const team of teams || []) {
      await tagSubscriber(team.captain_email, 'final-reveal-live');
    }
    console.log(`Tagged ${teams?.length || 0} teams with final-reveal-live`);
  } catch (err) {
    console.error('Final Reveal email error:', err);
  }
}

module.exports = { router, startScheduler };
