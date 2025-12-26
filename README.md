# LottoCheck

A CloudFlare Worker that monitors Mega Millions and Powerball jackpots daily and provides notifications when they exceed your threshold.

## Features

- **Automated Daily Checks**: Runs automatically at 3pm ET every day
- **Dual Lottery Support**: Monitors both Mega Millions and Powerball
- **Configurable Threshold**: Set your own jackpot threshold (defaults to $1.5 billion)
- **Real-time Data**: Scrapes official lottery websites for current jackpot amounts
- **HTTP API**: Test endpoint for manual checks during development
- **Zero Cost**: Runs on CloudFlare's free tier

## How It Works

The worker fetches lottery data from official sources daily:
- **Mega Millions**: Uses official API endpoint for reliable, structured data
- **Powerball**: Scrapes the official website HTML

Extracted data includes:
- Current jackpot amount (e.g., "$1.70 Billion")
- Normalized jackpot value in millions (for threshold comparisons)
- Next drawing date

Currently logs results to CloudFlare's dashboard. Notification functionality is planned for a future release.

## Setup

### Prerequisites

- Node.js 16+ and npm
- CloudFlare account (free tier works)
- Wrangler CLI (installed automatically with `npm install`)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd LottoCheck

# Install dependencies
npm install
```

## Development

### Local Testing

Start the development server:

```bash
npm run dev
```

Visit `http://localhost:8787` to see current jackpot data in JSON format:

```json
{
  "timestamp": "2025-12-24T12:13:06.388Z",
  "megaMillions": {
    "lottery": "Mega Millions",
    "jackpot": "$125 Million",
    "jackpotAmount": 125,
    "nextDrawing": "Fri, Dec 26, 2025",
    "exceedsThreshold": false
  },
  "powerball": {
    "lottery": "Powerball",
    "jackpot": "$1.70 Billion",
    "jackpotAmount": 1700,
    "nextDrawing": "Mon, Dec 22, 2025",
    "exceedsThreshold": true
  },
  "threshold": {
    "amount": 1500,
    "display": "$1.50 Billion",
    "exceeded": true,
    "exceedingLotteries": ["Powerball"]
  }
}
```

**Note**: Scheduled triggers don't run automatically in local development. Use the HTTP endpoint for testing.

## Deployment

Deploy to CloudFlare Workers:

```bash
npm run deploy
```

After deployment:
- The worker runs automatically at 3pm ET daily (8pm UTC)
- View logs in CloudFlare Dashboard → Workers → lottocheck → Logs → Real-time Logs
- Visit your worker URL to manually check current jackpots

## Configuration

### Schedule

The cron schedule is configured in `wrangler.toml`:

```toml
[triggers]
crons = ["0 20 * * *"]  # 8pm UTC = 3pm EST / 4pm EDT
```

Modify this cron expression to change the check frequency.

### Jackpot Threshold

The threshold is configured in `wrangler.toml`:

```toml
[vars]
JACKPOT_THRESHOLD = "1500"  # in millions ($1.5 billion)
```

Adjust this value to set your preferred notification threshold:
- `"1000"` = $1 billion
- `"1500"` = $1.5 billion (default)
- `"2000"` = $2 billion

The threshold is validated on startup and falls back to the default if invalid.

### Data Sources

The worker uses different methods to fetch data from each lottery:

**Mega Millions** (API):
- Endpoint: `https://www.megamillions.com/cmspages/utilservice.asmx/GetLatestDrawData`
- Uses official API for reliable, structured data
- If the endpoint changes, update the URL in `checkMegaMillions()` in `src/index.js`

**Powerball** (Web Scraping):
- URL: https://www.powerball.com/
- Scrapes HTML with regex patterns
- If the site's HTML structure changes, update the regex patterns in `checkPowerball()` in `src/index.js`

## Architecture

The worker exports two handlers:

1. **`fetch()`** - HTTP handler for manual testing and on-demand checks
2. **`scheduled()`** - Cron handler that runs on the configured schedule

Both handlers use the same data fetching functions (`checkMegaMillions()` and `checkPowerball()`), which:
- **Mega Millions**: Calls official API endpoint for structured JSON data
- **Powerball**: Scrapes HTML with multiple regex patterns for robustness
- Return standardized data objects
- Handle errors gracefully without throwing

## Future Enhancements

- [ ] Add notification system (email, SMS, or webhook)
- [ ] Store last-notified amount to avoid duplicate alerts

## License

MIT
