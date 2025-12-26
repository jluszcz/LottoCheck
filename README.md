# LottoCheck

A CloudFlare Worker that monitors Mega Millions and Powerball jackpots daily and provides notifications when they exceed your threshold.

## Features

- **Automated Daily Checks**: Runs automatically at 3pm ET every day
- **Dual Lottery Support**: Monitors both Mega Millions and Powerball
- **Configurable Threshold**: Set your own jackpot threshold (defaults to $1.5 billion)
- **Email Notifications**: Get notified via MailChannels when jackpots cross your threshold
- **Smart Threshold Crossing Detection**: Only notifies when jackpot moves from below to above threshold
- **Persistent State**: Uses CloudFlare KV to remember previous jackpot amounts
- **Real-time Data**: Fetches from official lottery sources
- **HTTP API**: Test endpoint for manual checks during development
- **Zero Cost**: Runs on CloudFlare's free tier (including email via MailChannels)

## How It Works

The worker runs daily at 3pm ET and:

1. **Fetches Current Jackpots** from official sources:
   - **Mega Millions**: Uses official API endpoint for reliable, structured data
   - **Powerball**: Scrapes the official website HTML

2. **Retrieves Previous Jackpots** from CloudFlare KV storage

3. **Detects Threshold Crossings**:
   - Compares previous and current jackpot amounts
   - Only triggers notifications when a jackpot crosses from below to above your threshold
   - Prevents duplicate notifications when jackpots stay above threshold

4. **Sends Email Notifications** (via MailChannels) when a threshold crossing is detected, including:
   - Lottery name
   - Previous and current jackpot amounts
   - Your threshold
   - Next drawing date

5. **Stores Current Jackpots** in KV for the next run

6. **Logs Results** to CloudFlare's dashboard for monitoring

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

## Testing

### Running Tests

The project includes a comprehensive test suite covering all functionality.

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch
```

### Test Structure

Tests are organized by feature area:
- **Fetch handler**: HTTP endpoint functionality
- **Scheduled handler**: Cron trigger and logging behavior
- **KV Storage**: Previous jackpot retrieval and storage
- **Threshold Crossing Detection**: Below→above crossing logic
- **Email Notifications**: MailChannels integration and HTML formatting
- **Integration**: End-to-end scheduled handler with KV and email
- **Threshold checking**: Jackpot comparison logic and edge cases
- **Mega Millions API**: API response parsing and error handling
- **Powerball scraping**: HTML parsing with multiple patterns

### Test Helpers and Fixtures

The test suite uses helper functions and fixtures to reduce duplication:

```javascript
// Use test fixtures for consistent data
setupMockFetch({
  megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount,
  powerballJackpot: fixtures.powerball.twoBillion
});

// Or use individual mock helpers
mockMegaMillionsResponse(1700000000);
mockPowerballResponse('$1.50 Billion');
```

Available fixtures:
- `fixtures.megaMillions`: Common jackpot amounts (billion, halfBillion, twoBillion)
- `fixtures.powerball`: Formatted jackpot strings
- `fixtures.dates`: Test date values
- `fixtures.thresholds`: Common threshold values

### Continuous Integration

Tests run automatically on:
- Every push to `main` branch
- Every pull request to `main` branch

GitHub Actions workflow runs tests and must pass before PRs can be merged.

### Test Coverage

The test suite provides comprehensive coverage:
- ✓ All public functions tested
- ✓ Success and error paths covered
- ✓ Edge cases validated (null/undefined handling, missing data)
- ✓ HTTP headers and response format verified
- ✓ Threshold logic tested with various scenarios

**Note**: Coverage reporting is not available due to CloudFlare Workers environment limitations (no `node:inspector` support).

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

### Email Notifications

Email notifications are sent via MailChannels when a jackpot crosses your threshold.

**Production Setup** (recommended - keeps emails private):
```bash
# Set secrets that won't be committed to git
wrangler secret put FROM_EMAIL
# Enter: alerts@yourdomain.com

wrangler secret put TO_EMAIL
# Enter: your-email@example.com

# Deploy
npm run deploy
```

**Local Development Setup**:
```bash
# Copy the example file
cp .dev.vars.example .dev.vars

# Edit .dev.vars with your actual email addresses
# This file is in .gitignore and won't be committed

# Run locally
npm run dev
```

**Note**: If these variables are not set, the worker will skip email sending and only log results.

### KV Storage

The worker uses CloudFlare KV to store previous jackpot amounts for threshold crossing detection.

**Setup Steps**:
1. Create KV namespaces:
   ```bash
   wrangler kv:namespace create "LOTTERY_STATE"
   wrangler kv:namespace create "LOTTERY_STATE" --preview
   ```
2. Update `wrangler.toml` with the returned namespace IDs:
   ```toml
   [[kv_namespaces]]
   binding = "LOTTERY_STATE"
   id = "your-production-namespace-id"
   ```
3. Deploy the worker

**Note**: If KV is not configured, the worker will treat all jackpots as first-time checks (previous amount = $0).

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

The **scheduled handler** integrates all components:
1. Fetches current jackpots using `checkMegaMillions()` and `checkPowerball()`
2. Retrieves previous jackpots from KV using `getPreviousJackpot()`
3. Detects threshold crossings using `detectThresholdCrossing()`
4. Sends email notifications via `sendEmail()` (MailChannels integration)
5. Stores current jackpots using `storePreviousJackpot()`

Data fetching functions:
- **Mega Millions**: Calls official API endpoint for structured JSON data
- **Powerball**: Scrapes HTML with multiple regex patterns for robustness
- Return standardized data objects
- Handle errors gracefully without throwing

## License

MIT
