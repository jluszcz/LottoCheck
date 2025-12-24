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
   - Logs jackpot data to CloudFlare dashboard
   - Production notification logic should be added here

### Data Flow

Both handlers call the same data fetching functions in parallel:
- `checkMegaMillions()` - Calls Mega Millions API endpoint
- `checkPowerball()` - Scrapes powerball.com HTML

Each returns a standardized object:
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

## Future Work

Notification logic is not yet implemented. When adding:
- Use environment variables for notification credentials (email/SMS/webhook)
- Store last-notified threshold in KV or Durable Objects to avoid repeat notifications
- Add threshold configuration (e.g., notify when jackpot > $500M)
