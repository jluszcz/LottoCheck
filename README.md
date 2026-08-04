# LottoCheck

A CloudFlare Worker that monitors Mega Millions and Powerball jackpots daily and provides notifications when they exceed your threshold.

## Features

- **Automated Daily Checks**: Runs automatically every day at 8pm UTC (3pm EST / 4pm EDT — a fixed UTC cron doesn't follow daylight saving)
- **Dual Lottery Support**: Monitors both Mega Millions and Powerball
- **Configurable Threshold**: Set your own jackpot threshold (defaults to $1.5 billion)
- **Push Notifications**: Get notified via [ntfy](https://ntfy.sh) when jackpots cross your threshold
- **Smart Threshold Crossing Detection**: Only notifies when jackpot moves from below to above threshold
- **Persistent State**: Uses CloudFlare KV to remember previous jackpot amounts
- **Real-time Data**: Fetches from official lottery sources
- **HTTP API**: Test endpoint for manual checks during development
- **Zero Cost**: Runs on CloudFlare's free tier; ntfy.sh is free with no signup

## How It Works

The worker runs daily and:

1. **Fetches Current Jackpots** from official sources:
   - **Mega Millions**: Uses official API endpoint for reliable, structured data
   - **Powerball**: Scrapes the official website HTML

2. **Retrieves Previous Jackpots** from CloudFlare KV storage

3. **Detects Threshold Crossings**:
   - Compares previous and current jackpot amounts
   - Only triggers notifications when a jackpot crosses from below to above your threshold
   - Prevents duplicate notifications when jackpots stay above threshold

4. **Sends Push Notifications** (via [ntfy](https://ntfy.sh)) when a threshold crossing is detected, including:
   - Lottery name
   - Previous and current jackpot amounts
   - Your threshold
   - Next drawing date

5. **Stores Current Jackpots** in KV for the next run. Storage is skipped for a lottery when its data fetch failed (so a transient error can't trigger a duplicate alert later), when reading its previous state from KV failed (an unknown previous amount must not be treated as a fresh crossing), or when its notification failed to send (so the crossing is retried on the next run)

6. **Alerts on Failure** — if a lottery check fails (upstream outage, or the Powerball markup changing under the scraper), a low-priority ntfy message says so, at most once per lottery per day. A broken check preserves state correctly and logs the reason, but "the page changed months ago and I never noticed" is the most likely way this app quietly stops doing its job

7. **Logs Results** to CloudFlare's dashboard for monitoring

## Setup

### Prerequisites

- Node.js 20+ and npm
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

## Code Quality

The project uses [Prettier](https://prettier.io/) for formatting and [ESLint](https://eslint.org/) for linting. Both run in CI and must pass before a PR can be merged.

```bash
# Auto-format all files
npm run format

# Verify formatting without writing changes (used in CI)
npm run format:check

# Run the linter
npm run lint
```

Prettier is configured in `.prettierrc.json` (tabs, single quotes, 120-char width) and ESLint in `eslint.config.js` (flat config, `@eslint/js` recommended rules). These checks also run locally via the [pre-commit](https://pre-commit.com/) hooks in `.pre-commit-config.yaml`.

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
- **Notifications**: ntfy publishing and plain-text message formatting
- **Integration**: End-to-end scheduled handler with KV and notifications
- **Threshold checking**: Jackpot comparison logic and edge cases
- **Mega Millions API**: API response parsing and error handling
- **Powerball scraping**: HTML parsing with multiple patterns

### Test Helpers and Fixtures

Outbound requests are mocked by stubbing the global `fetch` with a per-origin
router (the Workers Vitest pool makes `globalThis.fetch` writable for this).
Helper functions and fixtures reduce duplication:

```javascript
// Mock both lotteries with successful responses
mockLotteries({
	megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount,
	powerballJackpot: fixtures.powerball.twoBillion,
});

// Or mock each origin individually (body, status)
mockMegaMillions(megaMillionsBody(1700000000));
mockPowerball(powerballHtml('$1.50 Billion'));
mockMegaMillions('Server error', 500);

// Mock ntfy publishes (returns recorded requests) and bindings for
// scheduled-handler tests
const ntfy = mockNtfy();
const mockEnv = createMockEnv({
	LOTTERY_STATE: createMockKV({ 'Mega Millions': { jackpotAmount: 1000 } }),
	NTFY_TOPIC: 'test-topic',
});
```

Available fixtures:

- `fixtures.megaMillions`: Common jackpot amounts (billion, halfBillion, twoBillion)
- `fixtures.powerball`: Formatted jackpot strings
- `fixtures.dates`: Test date values

### Continuous Integration

Checks run automatically on:

- Every push to `main` branch
- Every pull request to `main` branch

`.github/workflows/ci.yml` is a thin caller of `jluszcz/github-utils/.github/workflows/node-ci.yml`, so the
steps live in that shared workflow. On Node 22 it runs three named steps that must all pass before a PR can merge:

1. **Build** (`npm ci`, then `npm run build`) — the build is a no-op here, but CI invokes it
2. **Tests** (`npm test`) — Vitest runs the full test suite
3. **Lint** (`npm run lint`, then `npm run format:check`) — ESLint, then Prettier style verification

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

- The worker runs automatically at 8pm UTC daily (3pm EST / 4pm EDT)
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
JACKPOT_THRESHOLD_MILLIONS = "1250"  # $1.25 billion — the value this repo ships
```

Adjust this value to set your preferred notification threshold:

- `"1000"` = $1 billion
- `"1250"` = $1.25 billion (the shipped value)
- `"1500"` = $1.5 billion (the code default, used when the var is unset or invalid)
- `"2000"` = $2 billion

The threshold is validated on startup and falls back to the default if invalid.

### Push Notifications (ntfy)

Notifications are sent as push messages via [ntfy](https://ntfy.sh) when a jackpot crosses your threshold. ntfy.sh is free, requires no account or API key, and delivers to the open-source [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) and [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) apps.

Failed checks also notify, at `Priority: low` and no more than once per lottery per day (de-duplicated through a
`<lottery>:lastErrorAlert` KV key). Jackpot-crossing alerts are `Priority: high`.

**One-time setup**:

1. Pick a topic name. Anyone who knows the topic can read and publish to it, so treat it like a password — use something long and unguessable (e.g., `lottocheck-x7Kp2mQv9`)
2. Install the ntfy app on your phone and subscribe to that topic

**Production Setup** (keeps the topic private):

```bash
# Set a secret that won't be committed to git
wrangler secret put NTFY_TOPIC
# Enter: your unguessable topic name

# Deploy
npm run deploy
```

**Local Development Setup**:

```bash
# Copy the example file
cp .dev.vars.example .dev.vars

# Edit .dev.vars with your actual topic name
# This file is in .gitignore and won't be committed

# Run locally
npm run dev
```

**Note**: If `NTFY_TOPIC` is not set, the worker will skip notifications and only log results.

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

The **scheduled handler** integrates all components, processing each lottery through `processLottery()`:

1. Fetches current jackpots using `checkMegaMillions()` and `checkPowerball()`
2. Retrieves previous jackpots from KV using `getPreviousJackpot()`
3. Detects threshold crossings using `detectThresholdCrossing()`
4. Sends push notifications via `sendNtfyNotification()` (HTTP POST to ntfy.sh)
5. Stores current jackpots using `storePreviousJackpot()` — skipped when the fetch, the KV read, or the notification failed, so errors never overwrite good state and missed notifications retry on the next run

Data fetching functions:

- **Mega Millions**: Calls official API endpoint for structured JSON data
- **Powerball**: Scrapes HTML with multiple regex patterns for robustness
- Return standardized data objects
- Handle errors gracefully without throwing

## License

MIT
