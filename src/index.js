/**
 * LottoCheck - CloudFlare Worker to check lottery jackpots
 * Checks Mega Millions and Powerball jackpots daily at 3pm ET
 */

// Default threshold: $1.5 billion (represented in millions)
const DEFAULT_THRESHOLD_MILLIONS = 1500;

// Conversion constant
const BILLION_IN_MILLIONS = 1000;

/**
 * Get threshold from environment or use default
 * @param {object} env - Environment variables
 * @returns {number} Threshold amount in millions
 */
export function getThreshold(env) {
	const parsed = parseFloat(env?.JACKPOT_THRESHOLD);
	return !isNaN(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD_MILLIONS;
}

/**
 * Get previous jackpot amount from KV storage
 * @param {KVNamespace} kv - CloudFlare KV namespace
 * @param {string} lotteryName - "Mega Millions" or "Powerball"
 * @returns {Promise<number|null>} Previous jackpot amount in millions, 0 if no
 *   state exists yet, or null when the read failed (caller should skip the run)
 */
export async function getPreviousJackpot(kv, lotteryName) {
	// Handle undefined KV (local dev, tests without KV binding). In production
	// a missing binding makes every above-threshold run look like a fresh
	// crossing, so warn loudly rather than fail silently.
	if (!kv) {
		console.warn(`No KV binding for ${lotteryName}; treating previous jackpot as 0 (duplicate alerts possible)`);
		return 0;
	}

	let stored;
	try {
		stored = await kv.get(lotteryName);
	} catch (error) {
		// A failed read must not be treated as "no previous state" (0) — that
		// would make an above-threshold jackpot look like a fresh crossing and
		// re-send the alert; null tells the caller to skip this run instead
		console.error(`Error reading previous jackpot for ${lotteryName}:`, error.message);
		return null;
	}

	// Return 0 if no previous state exists
	if (!stored) {
		return 0;
	}

	try {
		const data = JSON.parse(stored);
		return Number.isFinite(data.jackpotAmount) ? data.jackpotAmount : 0;
	} catch (error) {
		// Unlike a transient read failure, a corrupt stored value is permanent:
		// returning null here would skip the store forever and silently disable
		// this lottery. Treat it as 0 so the next successful run overwrites the
		// bad value — worst case is one duplicate alert.
		console.error(`Corrupt stored state for ${lotteryName}, treating as 0 so the next run repairs it:`, error.message);
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
			lastChecked: new Date().toISOString(),
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
	// Only notify on the upward crossing, not when the jackpot stays above
	const crossed = previousAmount < thresholdMillions && currentAmount >= thresholdMillions;

	return {
		crossed,
		previousAmount,
		currentAmount,
		threshold: thresholdMillions,
	};
}

/**
 * Build the plain-text body for a threshold crossing notification
 * @param {string} lotteryName - Name of lottery
 * @param {number} previousAmount - Previous amount in millions
 * @param {number} currentAmount - Current amount in millions
 * @param {number} threshold - Threshold in millions
 * @param {string} nextDrawing - Next drawing date string
 * @returns {string} Plain-text notification body
 */
export function buildNotificationMessage(lotteryName, previousAmount, currentAmount, threshold, nextDrawing) {
	return [
		`${lotteryName} has crossed your threshold!`,
		'',
		`Previous: ${formatJackpotDisplay(previousAmount)}`,
		`Current: ${formatJackpotDisplay(currentAmount)}`,
		`Your threshold: ${formatJackpotDisplay(threshold)}`,
		`Next drawing: ${nextDrawing}`,
	].join('\n');
}

/**
 * Check if ntfy notification configuration is valid
 * @param {Object} env - Environment object
 * @returns {boolean} True if NTFY_TOPIC is configured
 */
export function isNtfyConfigured(env) {
	return !!env?.NTFY_TOPIC;
}

/**
 * Send a push notification via ntfy.sh
 * @param {string} topic - The ntfy topic to publish to (env.NTFY_TOPIC; the topic
 *   name acts as the credential, so keep it secret and unguessable)
 * @param {string} title - Notification title (ASCII only — HTTP header values
 *   cannot carry emoji; the Tags header adds the 🎰 icon instead)
 * @param {string} message - Notification body
 * @returns {Promise<{success: boolean, error?: string}>} Send result
 */
export async function sendNtfyNotification(topic, title, message) {
	try {
		const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
			method: 'POST',
			headers: {
				Title: title,
				Priority: 'high',
				Tags: 'slot_machine',
			},
			body: message,
		});

		if (!response.ok) {
			return {
				success: false,
				error: `ntfy send failed: ${response.status} ${response.statusText}`,
			};
		}

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: `ntfy send failed: ${error.message || error}`,
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

/**
 * Process one lottery: detect a threshold crossing, notify, and update stored state.
 * The KV update is skipped when the fetch failed (keeps the last good amount so a
 * transient error can't trigger a duplicate alert later), when the KV read failed
 * (an unknown previous amount must not be treated as 0), and when a notification
 * failed to send (so the crossing is retried on the next run).
 * @param {object} env - Environment variables
 * @param {LotteryResult} current - Current lottery result
 * @param {number} thresholdMillions - Threshold in millions
 * @returns {Promise<void>}
 */
async function processLottery(env, current, thresholdMillions) {
	if (current.error) {
		console.error(`${current.lottery}: fetch failed, keeping previous state:`, current.error);
		return;
	}

	const previousAmount = await getPreviousJackpot(env.LOTTERY_STATE, current.lottery);
	if (previousAmount === null) {
		console.error(`${current.lottery}: KV read failed, skipping this run to avoid a duplicate alert`);
		return;
	}

	const crossing = detectThresholdCrossing(previousAmount, current.jackpotAmount, thresholdMillions);

	if (crossing.crossed) {
		console.log(`THRESHOLD CROSSED: ${current.lottery} went from ${previousAmount}M to ${current.jackpotAmount}M`);

		if (isNtfyConfigured(env)) {
			const message = buildNotificationMessage(
				current.lottery,
				previousAmount,
				current.jackpotAmount,
				thresholdMillions,
				current.nextDrawing,
			);
			const result = await sendNtfyNotification(env.NTFY_TOPIC, `${current.lottery} Jackpot Alert!`, message);

			if (!result.success) {
				console.error(
					`Notification failed for ${current.lottery}, keeping previous state to retry next run:`,
					result.error,
				);
				return;
			}
			console.log(`Notification sent successfully for ${current.lottery}`);
		}
	}

	await storePreviousJackpot(env.LOTTERY_STATE, current.lottery, current.jackpotAmount);
}

export default {
	/**
	 * HTTP handler - for testing purposes
	 * @param {Request} request
	 * @param {object} env - Environment variables
	 * @returns {Promise<Response>} JSON response with lottery data and threshold information
	 */
	async fetch(request, env) {
		try {
			// Check both lotteries in parallel
			const [megaMillions, powerball] = await Promise.all([checkMegaMillions(), checkPowerball()]);

			// Check against threshold and annotate results
			const thresholdResults = checkThresholds(megaMillions, powerball, getThreshold(env));

			const results = {
				timestamp: new Date().toISOString(),
				...thresholdResults,
			};

			return new Response(JSON.stringify(results, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			return new Response(JSON.stringify({ error: error.message }, null, 2), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},

	/**
	 * Scheduled handler - runs on cron trigger
	 * @param {ScheduledController} controller
	 * @param {object} env - Environment variables
	 * @returns {Promise<void>} Logs jackpot data and sends notifications on threshold crossing
	 */
	async scheduled(controller, env) {
		console.log('LottoCheck: Starting jackpot check at', new Date().toISOString());

		try {
			// Fetch current jackpots in parallel
			const [megaMillions, powerball] = await Promise.all([checkMegaMillions(), checkPowerball()]);

			const thresholdMillions = getThreshold(env);

			// Detect crossings, notify, and update stored state per lottery
			await Promise.all([
				processLottery(env, megaMillions, thresholdMillions),
				processLottery(env, powerball, thresholdMillions),
			]);

			// Log annotated results
			const results = checkThresholds(megaMillions, powerball, thresholdMillions);
			console.log('Mega Millions:', results.megaMillions);
			console.log('Powerball:', results.powerball);
			console.log('Threshold:', results.threshold);

			if (results.threshold.exceeded) {
				console.log(
					`ALERT: ${results.threshold.exceedingLotteries.join(' and ')} exceeded threshold of ${results.threshold.display}`,
				);
			}
		} catch (error) {
			console.error('Error checking jackpots:', error);
		}
	},
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
 * @param {number} thresholdMillions - Threshold in millions
 * @returns {ThresholdResults} Results with threshold information
 */
function checkThresholds(megaMillions, powerball, thresholdMillions) {
	// Check each lottery against threshold (only if no error and valid number)
	const megaExceeds =
		!megaMillions.error &&
		typeof megaMillions.jackpotAmount === 'number' &&
		megaMillions.jackpotAmount >= thresholdMillions;
	const powerballExceeds =
		!powerball.error && typeof powerball.jackpotAmount === 'number' && powerball.jackpotAmount >= thresholdMillions;

	// Build list of lotteries that exceed threshold
	const exceedingLotteries = [];
	if (megaExceeds) exceedingLotteries.push('Mega Millions');
	if (powerballExceeds) exceedingLotteries.push('Powerball');

	return {
		megaMillions: {
			...megaMillions,
			exceedsThreshold: megaExceeds,
		},
		powerball: {
			...powerball,
			exceedsThreshold: powerballExceeds,
		},
		threshold: {
			amount: thresholdMillions,
			display: formatJackpotDisplay(thresholdMillions),
			exceeded: exceedingLotteries.length > 0,
			exceedingLotteries,
		},
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
				'Content-Type': 'application/json',
			},
			body: '{}',
		});

		if (!response.ok) {
			throw new Error(`Mega Millions API returned ${response.status} ${response.statusText}`);
		}

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
			year: 'numeric',
		});

		return {
			lottery: 'Mega Millions',
			jackpot,
			jackpotAmount,
			nextDrawing,
		};
	} catch (error) {
		return {
			lottery: 'Mega Millions',
			jackpot: 'Error',
			jackpotAmount: 0,
			nextDrawing: 'Error',
			error: error.message,
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

		if (!response.ok) {
			throw new Error(`Powerball site returned ${response.status} ${response.statusText}`);
		}

		const html = await response.text();

		// Extract jackpot amount. The current markup puts the label and amount in
		// separate spans:
		//   <span class="game-title ...">Estimated Jackpot</span>
		//   <span class="game-jackpot-number ...">$375 Million</span>
		// No catch-all "$X Million" fallback: the page also shows cash values and
		// prize tiers, so matching an unanchored amount risks reporting the wrong
		// number. Better to fail loudly and keep the previous state.
		const jackpotPatterns = [
			/game-jackpot-number[^>]*>\s*\$([0-9,.]+)\s*(Million|Billion)/i,
			/Estimated Jackpot:?[\s\S]{0,200}?\$([0-9,.]+)\s*(Million|Billion)/i,
			/Jackpot:\s*\$([0-9,.]+)\s*(Million|Billion)/i,
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
		// Note: Must match "Next Drawing" to avoid matching past drawing dates
		const drawingPatterns = [
			/Next Drawing[^>]*>[\s\S]{0,100}?([A-Za-z]{3},\s*[A-Za-z]{3}\s*\d{1,2},\s*\d{4})/i, // Abbreviated with tags/whitespace
			/Next Drawing[^:]*:\s*([A-Za-z]{3},\s*[A-Za-z]{3}\s*\d{1,2},\s*\d{4})/i, // Abbreviated with colon
			/Next Drawing[^:]*:\s*([A-Za-z]+,\s*[A-Za-z]+\s*\d+,\s*\d{4})/i, // Full format with colon
			/Next Drawing[\s\S]{0,100}?([A-Za-z]{3},\s*[A-Za-z]{3}\s*\d{1,2},\s*\d{4})/i, // Abbreviated (flexible whitespace)
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
				error: 'Failed to parse jackpot from HTML',
			};
		}

		return {
			lottery: 'Powerball',
			jackpot,
			jackpotAmount,
			nextDrawing: nextDrawing || 'Not found',
		};
	} catch (error) {
		return {
			lottery: 'Powerball',
			jackpot: 'Error',
			jackpotAmount: 0,
			nextDrawing: 'Error',
			error: error.message,
		};
	}
}
