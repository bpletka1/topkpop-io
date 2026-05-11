# TopKpop.io — Mailchimp Automation Setup Guide

The backend automatically tags subscribers in Mailchimp when key events happen.
You need to create **Tag-based Automations** in Mailchimp for each email.

## How It Works
When an event happens (registration, Trove unlock, etc.), the backend adds a **tag** to the subscriber.
Mailchimp automation fires the corresponding email when that tag is applied.

---

## Email Automations to Create in Mailchimp

### Email 1 — Welcome / Mission Briefing
- **Trigger tag:** `registered`
- **Subject:** "Your Mission Has Been Accepted — Welcome, Recruit"
- **Template:** Use the welcome email HTML file from the project

### Email 2 — Trove 01 Unlock
- **Trigger tag:** `trove-1-unlocked`
- **Subject:** "TROVE 01 IS LIVE — Your First Mission Awaits"
- **Template:** Use the trove-01-unlock email HTML file

### Email 3 — Trove 02 Unlock
- **Trigger tag:** `trove-2-unlocked`
- **Subject:** "TROVE 02 IS LIVE — The Evidence Is Mounting"
- **Template:** Use the trove-02-unlock email HTML file

### Email 4 — Trove 03 Unlock
- **Trigger tag:** `trove-3-unlocked`
- **Subject:** "TROVE 03 IS LIVE — The Final Clues Are In"
- **Template:** Use the trove-03-unlock email HTML file

### Email 5 — Final Accusation Window Open
- **Trigger tag:** `accusation-open`
- **Subject:** "THE ACCUSATION WINDOW IS OPEN — Name Your Suspect"
- **Template:** Use the final-accusation email HTML file

### Email 6 — Winner Announcement
- **Trigger tag:** `game-complete`
- **Subject:** "THE SABOTEUR HAS BEEN REVEALED — See the Results"
- **Template:** Use the winner-announcement email HTML file

### Prize Fulfillment Email (Winner Only)
- **Trigger tag:** `winner-address-needed`
- **Subject:** "Congratulations! Please Send Us Your Mailing Address"
- **Body:** "Your team won! To send your Disneyland tickets, please reply with your mailing address."

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
| `trove-1-unlocked` | Monday Week 1 (or game start date) |
| `trove-2-unlocked` | Monday Week 2 |
| `trove-3-unlocked` | Monday Week 3 |
| `trove-1-submitted` | When Trove 01 is submitted |
| `trove-2-submitted` | When Trove 02 is submitted |
| `trove-3-submitted` | When Trove 03 is submitted |
| `accusation-submitted` | When Final Accusation is submitted |
| `game-complete` | When winner is announced (all participants) |
| `winner` | Winner team only |
| `winner-address-needed` | Winner — triggers prize fulfillment email |
