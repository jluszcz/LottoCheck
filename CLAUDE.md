# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LottoCheck is a CloudFlare Worker that monitors Mega Millions and Powerball jackpots. It runs on a daily schedule (3pm ET) and can be manually tested via HTTP endpoint.

## Development Commands

```bash
# Install dependencies
npm install

# Local development server (runs on http://localhost:8787)
npm run dev

# Deploy to CloudFlare
npm run deploy
```

## Architecture

### Dual-Handler Pattern

The worker exports an object with two handlers:

1. **`fetch(request, env, ctx)`** - HTTP handler for manual testing
   - Returns JSON with current jackpot data for both lotteries
   - Used during development to verify scraping logic

2. **`scheduled(controller, env, ctx)`** - Cron handler
   - Triggered daily at 8pm UTC (3pm EST / 4pm EDT)
   - Retrieves previous jackpot amounts from KV storage
   - Detects threshold crossings (below→above transitions)
   - Sends email notifications via MailChannels when threshold is crossed
   - Stores current jackpot amounts in KV for next run
   - Logs jackpot data to CloudFlare dashboard

### Data Flow

**fetch() handler** - Simple data fetching:
- Calls `checkMegaMillions()` and `checkPowerball()` in parallel
- Applies threshold checking via `checkThresholds()`
- Returns JSON response

**scheduled() handler** - Full notification workflow:
1. Fetches current jackpots: `checkMegaMillions()` and `checkPowerball()`
2. Retrieves previous amounts: `getPreviousJackpot()` from KV
3. Detects crossings: `detectThresholdCrossing()` for each lottery
4. Sends notifications: `sendEmail()` via MailChannels if threshold crossed
5. Stores current state: `storePreviousJackpot()` to KV

Data fetching functions return a standardized object:
```javascript
{
  lottery: string,        // "Mega Millions" or "Powerball"
  jackpot: string,        // Display format: "$1.70 Billion"
  jackpotAmount: number,  // Normalized to millions: 1700
  nextDrawing: string,    // "Fri, Dec 26, 2025"
  error?: string          // Present only if fetch failed
}
```

### Data Sources

**Mega Millions**: Uses official API endpoint
- Endpoint: `https://www.megamillions.com/cmspages/utilservice.asmx/GetLatestDrawData`
- Method: POST with empty JSON body `{}`
- Returns: JSON with jackpot data in `Jackpot.NextPrizePool` and `NextDrawingDate`
- Reliable and structured data

**Powerball**: HTML scraping with regex patterns
- URL: `https://www.powerball.com/`
- Uses multiple regex patterns to handle different HTML layouts
- Extracts numeric amount and unit (Million/Billion)
- Less reliable but no API currently available

Both functions normalize amounts to millions for threshold comparisons and handle errors gracefully by returning error objects instead of throwing.

## Testing Locally

1. Start dev server: `npm run dev`
2. Visit `http://localhost:8787` to see current jackpots
3. Scheduled triggers don't auto-run locally - use HTTP endpoint for testing

## CloudFlare Configuration

Scheduled trigger is defined in `wrangler.toml`:
```toml
[triggers]
crons = ["0 20 * * *"]  # 8pm UTC = 3pm EST / 4pm EDT
```

## Implemented Features

**Email Notifications via MailChannels**:
- Configured via `FROM_EMAIL` and `TO_EMAIL` environment variables in `wrangler.toml`
- Sends HTML-formatted emails when threshold is crossed
- Gracefully handles missing configuration (skips email sending)

**KV Storage**:
- Stores previous jackpot amounts to enable threshold crossing detection
- Key format: lottery name (e.g., "Mega Millions")
- Value format: JSON with `jackpotAmount` (in millions) and `lastChecked` timestamp
- Configured via `LOTTERY_STATE` KV namespace binding

**Threshold Crossing Detection**:
- Only notifies when jackpot transitions from below to above threshold
- Prevents duplicate notifications when jackpot stays above threshold
- Implemented via `detectThresholdCrossing()` function

## Future Enhancement Ideas

- Add SMS notifications (via Twilio or similar)
- Add webhook support for custom integrations
- Support for additional lotteries beyond Mega Millions and Powerball
- Web dashboard for viewing historical jackpot trends
