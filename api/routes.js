/**
 * TopKpop.io — Backend API Routes
 * Handles: Registration, Submissions, Leaderboard, Final Accusation, Admin, Scheduler
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const mailchimp = require('@mailchimp/mailchimp_marketing');
const cron = require('node-cron');
const path = require('path');

// ── Supabase Client ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    realtime: { enabled: false },
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

    res.json({
      success: true,
      message: `Trove 0${troveNumber} submission received! Your evidence is now under review.`,
      submission_id: sub.id,
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
    // Get all registrations with their submission scores
    const { data: teams, error } = await supabase
      .from('registrations')
      .select(`
        id, team_name, school_name, district, status,
        submissions (trove_number, final_score)
      `)
      .neq('status', 'disqualified')
      .order('team_name');

    if (error) throw error;

    // Calculate totals and rank
    const ranked = teams.map(team => {
      const scores = { trove1: 0, trove2: 0, trove3: 0 };
      (team.submissions || []).forEach(s => {
        if (s.final_score) scores[`trove${s.trove_number}`] = s.final_score;
      });
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

    // Get all teams with scores and accusations
    const { data: teams } = await supabase
      .from('registrations')
      .select(`
        id, team_name, captain_name, captain_email, school_name,
        submissions (trove_number, final_score),
        accusations (is_correct, accusation_score)
      `)
      .neq('status', 'disqualified');

    if (!teams || teams.length === 0) return;

    // Calculate total scores
    const scored = teams.map(team => {
      let total = 0;
      (team.submissions || []).forEach(s => { if (s.final_score) total += s.final_score; });
      const acc = team.accusations?.[0];
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

// Get/update game settings
router.get('/admin/settings', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('game_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

router.post('/admin/settings', adminAuth, async (req, res) => {
  const allowed = ['game_start_date', 'trove1_unlock', 'trove2_unlock', 'trove3_unlock',
    'accusation_open', 'accusation_close', 'correct_saboteur'];
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

function startScheduler() {
  // Run every Monday at 8:00 AM Pacific (16:00 UTC)
  cron.schedule('0 16 * * 1', async () => {
    console.log('Scheduler running — checking Trove unlocks...');
    try {
      const { data: settings } = await supabase
        .from('game_settings')
        .select('*')
        .eq('id', 1)
        .single();

      if (!settings) return;
      const today = new Date().toISOString().split('T')[0];

      // Trove 1 unlock
      if (settings.trove1_unlock && settings.trove1_unlock <= today && !settings.trove1_email_sent) {
        await sendTroveUnlockEmail(1);
        await supabase.from('game_settings').update({ trove1_email_sent: true }).eq('id', 1);
        console.log('Trove 1 unlock email sent');
      }

      // Trove 2 unlock
      if (settings.trove2_unlock && settings.trove2_unlock <= today && !settings.trove2_email_sent) {
        await sendTroveUnlockEmail(2);
        await supabase.from('game_settings').update({ trove2_email_sent: true }).eq('id', 1);
        console.log('Trove 2 unlock email sent');
      }

      // Trove 3 unlock
      if (settings.trove3_unlock && settings.trove3_unlock <= today && !settings.trove3_email_sent) {
        await sendTroveUnlockEmail(3);
        await supabase.from('game_settings').update({ trove3_email_sent: true }).eq('id', 1);
        console.log('Trove 3 unlock email sent');
      }

      // Accusation window check
      if (settings.accusation_close && settings.accusation_close <= today && !settings.winner_announced) {
        await checkAndAnnounceWinner();
      }

    } catch (err) {
      console.error('Scheduler error:', err);
    }
  }, { timezone: 'America/Los_Angeles' });

  console.log('TopKpop.io scheduler started — Trove unlocks run Mondays at 8AM PT');
}

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

module.exports = { router, startScheduler };
