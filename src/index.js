/**
 * LottoCheck - CloudFlare Worker to check lottery jackpots
 * Checks Mega Millions and Powerball jackpots daily at 3pm ET
 */

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

			const results = {
				timestamp: new Date().toISOString(),
				megaMillions,
				powerball
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

			// Log results
			console.log('Mega Millions:', megaMillions);
			console.log('Powerball:', powerball);

		} catch (error) {
			console.error('Error checking jackpots:', error);
		}
	}
};

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
		let jackpot;
		let jackpotAmount;

		if (jackpotInMillions >= 1000) {
			const billions = jackpotInMillions / 1000;
			jackpot = `$${billions.toFixed(2)} Billion`;
			jackpotAmount = jackpotInMillions;
		} else {
			jackpot = `$${jackpotInMillions.toFixed(0)} Million`;
			jackpotAmount = jackpotInMillions;
		}

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
