/**
 * LottoCheck - CloudFlare Worker to check lottery jackpots
 * Checks Mega Millions and Powerball jackpots daily at 3pm ET
 */

// Default threshold: $1.5 billion (represented in millions)
const DEFAULT_THRESHOLD_MILLIONS = 1500;

// Conversion constant
const BILLION_IN_MILLIONS = 1000;

/**
 * Get previous jackpot amount from KV storage
 * @param {KVNamespace} kv - CloudFlare KV namespace
 * @param {string} lotteryName - "Mega Millions" or "Powerball"
 * @returns {Promise<number>} Previous jackpot amount in millions (0 if not found)
 */
export async function getPreviousJackpot(kv, lotteryName) {
	// Handle undefined KV (local dev, tests without KV binding)
	if (!kv) {
		return 0;
	}

	try {
		const stored = await kv.get(lotteryName);

		// Return 0 if no previous state exists
		if (!stored) {
			return 0;
		}

		// Parse stored JSON
		const data = JSON.parse(stored);
		return data.jackpotAmount || 0;

	} catch (error) {
		// Log error but return 0 to allow processing to continue
		console.error(`Error reading previous jackpot for ${lotteryName}:`, error.message);
		return 0;
	}
}

/**
 * Store current jackpot amount in KV storage
 * @param {KVNamespace} kv - CloudFlare KV namespace
 * @param {string} lotteryName - "Mega Millions" or "Powerball"
 * @param {number} jackpotAmount - Current jackpot amount in millions
 * @returns {Promise<void>}
 */
export async function storePreviousJackpot(kv, lotteryName, jackpotAmount) {
	// Handle undefined KV (local dev, tests without KV binding)
	if (!kv) {
		return;
	}

	try {
		const data = {
			jackpotAmount,
			lastChecked: new Date().toISOString()
		};

		await kv.put(lotteryName, JSON.stringify(data));

	} catch (error) {
		// Log error but don't throw - storage failure shouldn't crash the worker
		console.error(`Error storing jackpot for ${lotteryName}:`, error.message);
	}
}

/**
 * @typedef {Object} ThresholdCrossingInfo
 * @property {boolean} crossed - Whether threshold was crossed (below→above)
 * @property {number} previousAmount - Previous jackpot amount in millions
 * @property {number} currentAmount - Current jackpot amount in millions
 * @property {number} threshold - Threshold in millions
 */

/**
 * Detect if jackpot crossed threshold (was below, now above)
 * @param {number} previousAmount - Previous jackpot amount in millions
 * @param {number} currentAmount - Current jackpot amount in millions
 * @param {number} thresholdMillions - Threshold in millions
 * @returns {ThresholdCrossingInfo} Crossing detection result
 */
export function detectThresholdCrossing(previousAmount, currentAmount, thresholdMillions) {
	// Validate inputs
	if (typeof previousAmount !== 'number' || isNaN(previousAmount)) {
		throw new Error('previousAmount must be a valid number');
	}
	if (typeof currentAmount !== 'number' || isNaN(currentAmount)) {
		throw new Error('currentAmount must be a valid number');
	}
	if (typeof thresholdMillions !== 'number' || isNaN(thresholdMillions)) {
		throw new Error('thresholdMillions must be a valid number');
	}

	// Return crossing info with crossed=true ONLY when:
	// - previousAmount < threshold AND currentAmount >= threshold
	// This ensures we only notify on the upward crossing, not when it stays above
	const crossed = previousAmount < thresholdMillions && currentAmount >= thresholdMillions;

	return {
		crossed,
		previousAmount,
		currentAmount,
		threshold: thresholdMillions
	};
}

/**
 * Build email HTML for threshold crossing notification
 * @param {string} lotteryName - Name of lottery
 * @param {number} previousAmount - Previous amount in millions
 * @param {number} currentAmount - Current amount in millions
 * @param {number} threshold - Threshold in millions
 * @param {string} nextDrawing - Next drawing date string
 * @returns {string} HTML email body
 */
export function buildNotificationEmail(lotteryName, previousAmount, currentAmount, threshold, nextDrawing) {
	// Validate inputs
	if (!lotteryName || typeof lotteryName !== 'string') {
		throw new Error('lotteryName must be a non-empty string');
	}
	if (typeof previousAmount !== 'number' || isNaN(previousAmount)) {
		throw new Error('previousAmount must be a valid number');
	}
	if (typeof currentAmount !== 'number' || isNaN(currentAmount)) {
		throw new Error('currentAmount must be a valid number');
	}
	if (typeof threshold !== 'number' || isNaN(threshold)) {
		throw new Error('threshold must be a valid number');
	}
	if (!nextDrawing || typeof nextDrawing !== 'string') {
		throw new Error('nextDrawing must be a non-empty string');
	}

	const previousDisplay = formatJackpotDisplay(previousAmount);
	const currentDisplay = formatJackpotDisplay(currentAmount);
	const thresholdDisplay = formatJackpotDisplay(threshold);

	return `
<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
		.container { max-width: 600px; margin: 0 auto; padding: 20px; }
		h2 { color: #2c3e50; }
		ul { background: #f4f4f4; padding: 20px; border-radius: 5px; }
		li { margin: 10px 0; }
		.footer { margin-top: 20px; font-size: 0.9em; color: #666; }
	</style>
</head>
<body>
	<div class="container">
		<h2>🎰 Lottery Jackpot Alert!</h2>
		<p><strong>${lotteryName}</strong> has crossed your threshold!</p>
		<ul>
			<li><strong>Previous:</strong> ${previousDisplay}</li>
			<li><strong>Current:</strong> ${currentDisplay}</li>
			<li><strong>Your threshold:</strong> ${thresholdDisplay}</li>
			<li><strong>Next drawing:</strong> ${nextDrawing}</li>
		</ul>
		<p class="footer">This is an automated notification from LottoCheck.</p>
	</div>
</body>
</html>
`.trim();
}

/**
 * Check if email configuration is valid
 * @param {Object} env - Environment object
 * @returns {boolean} True if both FROM_EMAIL and TO_EMAIL are configured
 */
export function isEmailConfigured(env) {
	return !!(env?.FROM_EMAIL && env?.TO_EMAIL);
}

/**
 * Send email notification via MailChannels
 * @param {string} fromEmail - Sender email (env.FROM_EMAIL)
 * @param {string} toEmail - Recipient email (env.TO_EMAIL)
 * @param {string} subject - Email subject
 * @param {string} htmlBody - HTML email body
 * @returns {Promise<{success: boolean, error?: string}>} Send result
 */
export async function sendEmail(fromEmail, toEmail, subject, htmlBody) {
	try {
		const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				personalizations: [{
					to: [{ email: toEmail }]
				}],
				from: { email: fromEmail },
				subject: subject,
				content: [{
					type: 'text/html',
					value: htmlBody
				}]
			})
		});

		if (response.ok) {
			return { success: true };
		} else {
			const errorText = await response.text().catch(() => '(unable to read error response)');
			return {
				success: false,
				error: `MailChannels API error: ${response.status} ${response.statusText} - ${errorText}`
			};
		}

	} catch (error) {
		return {
			success: false,
			error: `Email send failed: ${error.message}`
		};
	}
}

/**
 * @typedef {Object} LotteryResult
 * @property {string} lottery - Name of the lottery ("Mega Millions" or "Powerball")
 * @property {string} jackpot - Formatted jackpot display string (e.g., "$1.70 Billion")
 * @property {number} jackpotAmount - Jackpot amount in millions for comparisons
 * @property {string} nextDrawing - Formatted next drawing date
 * @property {string} [error] - Error message if fetch/parse failed
 */

/**
 * @typedef {Object} LotteryResultWithThreshold
 * @property {string} lottery - Name of the lottery
 * @property {string} jackpot - Formatted jackpot display string
 * @property {number} jackpotAmount - Jackpot amount in millions
 * @property {string} nextDrawing - Formatted next drawing date
 * @property {boolean} exceedsThreshold - Whether jackpot exceeds threshold
 * @property {string} [error] - Error message if fetch/parse failed
 */

/**
 * @typedef {Object} ThresholdInfo
 * @property {number} amount - Threshold amount in millions
 * @property {string} display - Formatted threshold display string
 * @property {boolean} exceeded - Whether any lottery exceeds threshold
 * @property {string[]} exceedingLotteries - List of lotteries that exceed threshold
 */

/**
 * @typedef {Object} ThresholdResults
 * @property {LotteryResultWithThreshold} megaMillions - Mega Millions data with threshold flag
 * @property {LotteryResultWithThreshold} powerball - Powerball data with threshold flag
 * @property {ThresholdInfo} threshold - Threshold metadata
 */

export default {
	/**
	 * HTTP handler - for testing purposes
	 * @param {Request} request
	 * @param {object} env - Environment variables
	 * @param {ExecutionContext} ctx
	 * @returns {Promise<Response>} JSON response with lottery data and threshold information
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
	 * @returns {Promise<void>} Logs jackpot data and sends notifications on threshold crossing
	 */
	async scheduled(controller, env, ctx) {
		console.log('LottoCheck: Starting jackpot check at', new Date().toISOString());

		try {
			// 1. Fetch current jackpots (parallel)
			const [megaMillions, powerball] = await Promise.all([
				checkMegaMillions(),
				checkPowerball()
			]);

			// 2. Get previous amounts from KV (parallel)
			const [prevMega, prevPowerball] = await Promise.all([
				getPreviousJackpot(env.LOTTERY_STATE, 'Mega Millions'),
				getPreviousJackpot(env.LOTTERY_STATE, 'Powerball')
			]);

			// 3. Check against threshold and annotate results
			const results = checkThresholds(megaMillions, powerball, env);
			const thresholdMillions = results.threshold.amount;

			// 4. Detect crossings for each lottery
			const megaCrossing = detectThresholdCrossing(
				prevMega,
				megaMillions.jackpotAmount,
				thresholdMillions
			);
			const powerballCrossing = detectThresholdCrossing(
				prevPowerball,
				powerball.jackpotAmount,
				thresholdMillions
			);

			// 5. Send email notifications if crossed (parallel)
			const notifications = [];

			if (megaCrossing.crossed && !megaMillions.error && isEmailConfigured(env)) {
				const html = buildNotificationEmail(
					'Mega Millions',
					prevMega,
					megaMillions.jackpotAmount,
					thresholdMillions,
					megaMillions.nextDrawing
				);
				notifications.push(
					sendEmail(
						env.FROM_EMAIL,
						env.TO_EMAIL,
						'🎰 Mega Millions Jackpot Alert!',
						html
					).then(result => ({ lottery: 'Mega Millions', ...result }))
				);
			}

			if (powerballCrossing.crossed && !powerball.error && isEmailConfigured(env)) {
				const html = buildNotificationEmail(
					'Powerball',
					prevPowerball,
					powerball.jackpotAmount,
					thresholdMillions,
					powerball.nextDrawing
				);
				notifications.push(
					sendEmail(
						env.FROM_EMAIL,
						env.TO_EMAIL,
						'🎰 Powerball Jackpot Alert!',
						html
					).then(result => ({ lottery: 'Powerball', ...result }))
				);
			}

			// Send email notifications in background (fire-and-forget)
			// Use ctx.waitUntil() to ensure emails send even after handler returns
			ctx.waitUntil(
				Promise.all(notifications).then((emailResults) => {
					emailResults.forEach((result) => {
						if (result.success) {
							console.log(`Email sent successfully for ${result.lottery}`);
						} else {
							console.error(`Email failed for ${result.lottery}:`, result.error);
						}
					});
				})
			);

			// 6. Store current amounts in KV for next run (always, even if errors)
			// Use ctx.waitUntil() to ensure KV operations complete even after handler returns
			ctx.waitUntil(Promise.all([
				storePreviousJackpot(env.LOTTERY_STATE, 'Mega Millions', megaMillions.jackpotAmount),
				storePreviousJackpot(env.LOTTERY_STATE, 'Powerball', powerball.jackpotAmount)
			]));

			// 7. Log results
			console.log('Mega Millions:', results.megaMillions);
			console.log('Powerball:', results.powerball);
			console.log('Threshold:', results.threshold);

			// Log threshold crossings
			if (megaCrossing.crossed) {
				console.log(`THRESHOLD CROSSED: Mega Millions went from ${prevMega}M to ${megaMillions.jackpotAmount}M`);
			}
			if (powerballCrossing.crossed) {
				console.log(`THRESHOLD CROSSED: Powerball went from ${prevPowerball}M to ${powerball.jackpotAmount}M`);
			}

			// Log alert if any lottery exceeds threshold (existing behavior)
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
 * @param {LotteryResult} megaMillions - Mega Millions result object
 * @param {LotteryResult} powerball - Powerball result object
 * @param {object} env - Environment variables
 * @returns {ThresholdResults} Results with threshold information
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
 * @returns {Promise<LotteryResult>}
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
 * @returns {Promise<LotteryResult>}
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
		// Handles both formats:
		// - Abbreviated: "Mon, Jan 5, 2026"
		// - Full: "Monday, January 5, 2026"
		const drawingPatterns = [
			/Next Drawing[^>]*>\s*([A-Za-z]{3},\s*[A-Za-z]{3}\s*\d{1,2},\s*\d{4})/i, // Abbreviated
			/Next Drawing[^:]*:\s*([A-Za-z]+,\s*[A-Za-z]+\s*\d+,\s*\d{4})/i,          // Full format
			/([A-Za-z]{3},\s*[A-Za-z]{3}\s*\d{1,2},\s*\d{4})/i,                       // Abbreviated (fallback)
			/([A-Za-z]+,\s*[A-Za-z]+\s*\d+,\s*\d{4})/i                                 // Full (fallback)
		];

		let nextDrawing = null;
		for (const pattern of drawingPatterns) {
			const match = html.match(pattern);
			if (match) {
				nextDrawing = match[1].trim();
				break;
			}
		}

		// Check if scraping was successful
		if (!jackpot) {
			return {
				lottery: 'Powerball',
				jackpot: 'Not found',
				jackpotAmount: 0,
				nextDrawing: nextDrawing || 'Not found',
				error: 'Failed to parse jackpot from HTML'
			};
		}

		return {
			lottery: 'Powerball',
			jackpot,
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
