/**
 * LottoCheck - CloudFlare Worker to check lottery jackpots
 * Checks Mega Millions and Powerball jackpots daily at 3pm ET
 */

// Default threshold: $1.5 billion (represented in millions)
const DEFAULT_THRESHOLD_MILLIONS = 1500;

// Conversion constant
const BILLION_IN_MILLIONS = 1000;

export default {
	/**
	 * HTTP handler - for testing purposes
	 * @param {Request} request
	 * @param {object} env - Environment variables
	 * @param {ExecutionContext} ctx
	 */
	async fetch(request, env, ctx) {
		try {
			// Check both lotteries in parallel
			const [megaMillions, powerball] = await Promise.all([
				checkMegaMillions(),
				checkPowerball()
			]);

			// Check against threshold and annotate results
			const thresholdResults = checkThresholds(megaMillions, powerball, env);

			const results = {
				timestamp: new Date().toISOString(),
				...thresholdResults
			};

			return new Response(JSON.stringify(results, null, 2), {
				headers: { 'Content-Type': 'application/json' }
			});

		} catch (error) {
			return new Response(JSON.stringify({ error: error.message }, null, 2), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	},

	/**
	 * Scheduled handler - runs on cron trigger
	 * @param {ScheduledController} controller
	 * @param {object} env - Environment variables
	 * @param {ExecutionContext} ctx
	 */
	async scheduled(controller, env, ctx) {
		console.log('LottoCheck: Starting jackpot check at', new Date().toISOString());

		try {
			// Check both lotteries in parallel
			const [megaMillions, powerball] = await Promise.all([
				checkMegaMillions(),
				checkPowerball()
			]);

			// Check against threshold and annotate results
			const results = checkThresholds(megaMillions, powerball, env);

			// Log results
			console.log('Mega Millions:', results.megaMillions);
			console.log('Powerball:', results.powerball);
			console.log('Threshold:', results.threshold);

			// Log alert if any lottery exceeds threshold
			if (results.threshold.exceeded) {
				console.log(`ALERT: ${results.threshold.exceedingLotteries.join(' and ')} exceeded threshold of ${results.threshold.display}`);
			}

		} catch (error) {
			console.error('Error checking jackpots:', error);
		}
	}
};

/**
 * Format jackpot amount for display
 * @param {number} amountInMillions - Jackpot amount in millions
 * @returns {string} Formatted display string (e.g., "$1.70 Billion" or "$500 Million")
 */
function formatJackpotDisplay(amountInMillions) {
	if (amountInMillions >= BILLION_IN_MILLIONS) {
		const billions = amountInMillions / BILLION_IN_MILLIONS;
		return `$${billions.toFixed(2)} Billion`;
	}
	return `$${amountInMillions.toFixed(0)} Million`;
}

/**
 * Check lottery results against threshold and annotate with threshold status
 * @param {object} megaMillions - Mega Millions result object
 * @param {object} powerball - Powerball result object
 * @param {object} env - Environment variables
 * @returns {object} Results with threshold information
 */
function checkThresholds(megaMillions, powerball, env) {
	// Get threshold from environment or use default
	const parsed = parseFloat(env?.JACKPOT_THRESHOLD);
	const thresholdMillions = !isNaN(parsed) && parsed > 0
		? parsed
		: DEFAULT_THRESHOLD_MILLIONS;

	// Check each lottery against threshold (only if no error and valid number)
	const megaExceeds = !megaMillions.error &&
		typeof megaMillions.jackpotAmount === 'number' &&
		megaMillions.jackpotAmount >= thresholdMillions;
	const powerballExceeds = !powerball.error &&
		typeof powerball.jackpotAmount === 'number' &&
		powerball.jackpotAmount >= thresholdMillions;

	// Build list of lotteries that exceed threshold
	const exceedingLotteries = [];
	if (megaExceeds) exceedingLotteries.push('Mega Millions');
	if (powerballExceeds) exceedingLotteries.push('Powerball');

	return {
		megaMillions: {
			...megaMillions,
			exceedsThreshold: megaExceeds
		},
		powerball: {
			...powerball,
			exceedsThreshold: powerballExceeds
		},
		threshold: {
			amount: thresholdMillions,
			display: formatJackpotDisplay(thresholdMillions),
			exceeded: exceedingLotteries.length > 0,
			exceedingLotteries
		}
	};
}

/**
 * Check current Mega Millions jackpot
 * @returns {Promise<{lottery: string, jackpot: string, jackpotAmount: number, nextDrawing: string, error?: string}>}
 */
async function checkMegaMillions() {
	try {
		const response = await fetch('https://www.megamillions.com/cmspages/utilservice.asmx/GetLatestDrawData', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: '{}'
		});

		const json = await response.json();
		const data = JSON.parse(json.d);

		// Extract jackpot data from API response
		const nextPrizePool = data.Jackpot.NextPrizePool;
		const nextDrawingDate = new Date(data.NextDrawingDate);

		// Convert to millions and format
		const jackpotInMillions = nextPrizePool / 1000000;
		const jackpot = formatJackpotDisplay(jackpotInMillions);
		const jackpotAmount = jackpotInMillions;

		// Format drawing date
		const nextDrawing = nextDrawingDate.toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});

		return {
			lottery: 'Mega Millions',
			jackpot,
			jackpotAmount,
			nextDrawing
		};

	} catch (error) {
		return {
			lottery: 'Mega Millions',
			jackpot: 'Error',
			jackpotAmount: 0,
			nextDrawing: 'Error',
			error: error.message
		};
	}
}

/**
 * Check current Powerball jackpot
 * @returns {Promise<{lottery: string, jackpot: string, jackpotAmount: number, nextDrawing: string, error?: string}>}
 */
async function checkPowerball() {
	try {
		const response = await fetch('https://www.powerball.com/');
		const html = await response.text();

		// Extract jackpot amount - look for patterns like "$1.70 Billion"
		const jackpotPatterns = [
			/Estimated Jackpot:\s*\$([0-9,.]+)\s*(Million|Billion)/i,
			/Jackpot:\s*\$([0-9,.]+)\s*(Million|Billion)/i,
			/\$([0-9,.]+)\s*(Million|Billion)/i
		];

		let jackpot = null;
		let jackpotAmount = 0;

		for (const pattern of jackpotPatterns) {
			const match = html.match(pattern);
			if (match) {
				const amount = parseFloat(match[1].replace(/,/g, ''));
				const unit = match[2].toLowerCase();
				jackpotAmount = unit === 'billion' ? amount * 1000 : amount;
				jackpot = `$${match[1]} ${match[2]}`;
				break;
			}
		}

		// Extract next drawing date
		const drawingPatterns = [
			/Next Drawing[^:]*:\s*([A-Za-z]+,\s*[A-Za-z]+\s*\d+,\s*\d{4})/i,
			/([A-Za-z]+,\s*[A-Za-z]+\s*\d+,\s*\d{4})/i
		];

		let nextDrawing = null;
		for (const pattern of drawingPatterns) {
			const match = html.match(pattern);
			if (match) {
				nextDrawing = match[1].trim();
				break;
			}
		}

		return {
			lottery: 'Powerball',
			jackpot: jackpot || 'Not found',
			jackpotAmount,
			nextDrawing: nextDrawing || 'Not found'
		};

	} catch (error) {
		return {
			lottery: 'Powerball',
			jackpot: 'Error',
			jackpotAmount: 0,
			nextDrawing: 'Error',
			error: error.message
		};
	}
}
