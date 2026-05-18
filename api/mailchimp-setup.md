# TopKpop.io — Mailchimp Automation Setup Guide

The backend automatically tags subscribers in Mailchimp when key events happen.
You need to create **Tag-based Automations** in Mailchimp for each email.

## How It Works
When an event happens (registration, Trove unlock, submission, etc.), the backend adds a **tag** to the subscriber.
Mailchimp automation fires the corresponding email when that tag is applied.

---

## Email Automations to Create in Mailchimp

### Email 1 — Welcome / Mission Briefing
- **Trigger tag:** `registered`
- **Subject:** "Your Mission Has Been Accepted — Welcome, Recruit"
- **Template file:** `pages/emails/email1_welcome.html`

### Email 2 — Trove 01 Unlock (sent when Trove 1 opens)
- **Trigger tag:** `trove-1-unlocked`
- **Subject:** "TROVE 01 IS LIVE — Your First Mission Awaits, Recruit"
- **Template file:** `pages/emails/email7_trove01_unlock.html`

### Email 3 — Trove 01 Submission Confirmed
- **Trigger tag:** `trove-1-submitted`
- **Subject:** "Identity Confirmed — Trove 01 Complete"
- **Template file:** `pages/emails/email2_trove01.html`

### Email 4 — Trove 02 Unlock (sent when Trove 2 opens)
- **Trigger tag:** `trove-2-unlocked`
- **Subject:** "TROVE 02 IS LIVE — The Evidence Is Mounting"
- **Template file:** `pages/emails/email8_trove02_unlock.html`

### Email 5 — Trove 02 Submission Confirmed
- **Trigger tag:** `trove-2-submitted`
- **Subject:** "Evidence Logged — Trove 02 Complete"
- **Template file:** `pages/emails/email3_trove02.html`

### Email 6 — Trove 03 Unlock (sent when Trove 3 opens)
- **Trigger tag:** `trove-3-unlocked`
- **Subject:** "TROVE 03 IS LIVE — The Final Clues Are In"
- **Template file:** `pages/emails/email9_trove03_unlock.html`

### Email 7 — Trove 03 Submission Confirmed
- **Trigger tag:** `trove-3-submitted`
- **Subject:** "All Evidence Collected — Trove 03 Complete"
- **Template file:** `pages/emails/email4_trove03.html`

### Email 8 — Final Accusation Window Open
- **Trigger tag:** `accusation-open`
- **Subject:** "THE ACCUSATION WINDOW IS OPEN — Name Your Suspect Now"
- **Template file:** `pages/emails/email10_accusation_open.html`

### Email 9 — Accusation Deadline Reminder (24 hours before close)
- **Trigger tag:** `accusation-deadline-reminder`
- **Subject:** "URGENT — Final Accusation Due Tomorrow at Midnight"
- **Template file:** `pages/emails/email5_reminder.html`

### Email 10 — Case Closed / Winner Reveal (all participants)
- **Trigger tag:** `game-complete`
- **Subject:** "CASE CLOSED — The Saboteur Has Been Revealed"
- **Template file:** `pages/emails/email6_winner.html`
- **Note:** Replace `[SABOTEUR_NAME]`, `[WINNING_TEAM_NAME]`, and `[SCORE]` with actual values before activating

### Email 11 — Prize Fulfillment (winner only)
- **Trigger tag:** `winner-address-needed`
- **Subject:** "Congratulations! Please Send Us Your Mailing Address"
- **Body:** "Your team won the TopKpop.io AI Super Sleuth Investigation! To ship your K-Pop Superfan Experience Box, please reply with your mailing address. Congratulations, Champion!"

### Email 12 — Weekly Score Summary (every Friday 5 PM PT)
- **Trigger tag:** `weekly-score-summary`
- **Subject:** "Case File Update — Your Weekly Score Report"
- **Merge fields available:** `*|TROVE1SC|*`, `*|TROVE2SC|*`, `*|TROVE3SC|*`, `*|TOTALSC|*`, `*|RANK|*`, `*|ANNAMSG|*`
- **Template:** Create in Mailchimp using the merge fields above. Suggested layout:
  - Header: "Case File Update — Week [n]" with the email_header_banner.png
  - Anna Im quote: `*|ANNAMSG|*`
  - Score table: Trove 01: `*|TROVE1SC|*` | Trove 02: `*|TROVE2SC|*` | Trove 03: `*|TROVE3SC|*` | Total: `*|TOTALSC|*`
  - Leaderboard rank: `*|RANK|*`
  - CTA button: "Check the Leaderboard" → https://www.topkpop.io/pages/leaderboard

---

## How to Create a Tag-Based Automation in Mailchimp

1. Go to **Automations** → **Create**
2. Choose **"Tag is applied"** as the trigger
3. Enter the tag name exactly as listed above
4. Add the email content (copy from the HTML template files)
5. Set delay to **immediately** (0 hours)
6. Activate the automation

---

## Tags Applied by the Backend (Reference)

| Tag | When Applied |
|-----|-------------|
| `registered` | On registration |
| `team-member` | For non-captain team members |
| `trove-1-unlocked` | Sunday 7 PM PT Week 1 |
| `trove-2-unlocked` | Sunday 7 PM PT Week 2 |
| `trove-3-unlocked` | Sunday 7 PM PT Week 3 |
| `trove-1-submitted` | When Trove 01 is submitted |
| `trove-2-submitted` | When Trove 02 is submitted |
| `trove-3-submitted` | When Trove 03 is submitted |
| `accusation-open` | Sunday 7 PM PT Day 22 |
| `accusation-submitted` | When Final Accusation is submitted |
| `accusation-deadline-reminder` | Day 24 (24 hrs before close) |
| `game-complete` | When winner is announced (all participants) |
| `winner` | Winner team only |
| `winner-address-needed` | Winner — triggers prize fulfillment email |
| `weekly-score-summary` | Every Friday 5 PM PT |
