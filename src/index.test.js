import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from './index.js';

/**
 * Test suite for LottoCheck CloudFlare Worker
 */

describe('LottoCheck Worker', () => {
	describe('fetch handler', () => {
		it('returns jackpot data for both lotteries', async () => {
			// Mock fetch for external API calls
			const mockFetch = vi.fn();

			// Mock Mega Millions API response
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					json: () => Promise.resolve({
						d: JSON.stringify({
							Jackpot: { NextPrizePool: 1700000000 },
							NextDrawingDate: '2025-12-26T00:00:00'
						})
					})
				})
			);

			// Mock Powerball HTML response
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					text: () => Promise.resolve(
						'<html>Estimated Jackpot: $1.50 Billion Next Drawing: Friday, December 27, 2024</html>'
					)
				})
			);

			// Replace global fetch
			global.fetch = mockFetch;

			const request = new Request('http://localhost');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			const data = await response.json();

			expect(data).toHaveProperty('timestamp');
			expect(data).toHaveProperty('megaMillions');
			expect(data).toHaveProperty('powerball');
			expect(data).toHaveProperty('threshold');

			expect(data.megaMillions.lottery).toBe('Mega Millions');
			expect(data.powerball.lottery).toBe('Powerball');
		});

		it('handles errors gracefully', async () => {
			// Mock fetch to throw an error
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			const request = new Request('http://localhost');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			const data = await response.json();

			// Should still return data, but with error fields
			expect(data.megaMillions).toHaveProperty('error');
			expect(data.powerball).toHaveProperty('error');
		});
	});

	describe('scheduled handler', () => {
		it('logs jackpot data on scheduled trigger', async () => {
			// Mock console.log to verify logging
			const consoleLogs = [];
			const originalLog = console.log;
			console.log = vi.fn((...args) => {
				consoleLogs.push(args.join(' '));
			});

			// Mock fetch for external API calls
			const mockFetch = vi.fn();
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					json: () => Promise.resolve({
						d: JSON.stringify({
							Jackpot: { NextPrizePool: 1700000000 },
							NextDrawingDate: '2025-12-26T00:00:00'
						})
					})
				})
			);
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					text: () => Promise.resolve(
						'<html>Estimated Jackpot: $1.50 Billion Next Drawing: Friday, December 27, 2024</html>'
					)
				})
			);
			global.fetch = mockFetch;

			const controller = { scheduledTime: Date.now(), cron: '0 20 * * *' };
			const ctx = createExecutionContext();

			await worker.scheduled(controller, env, ctx);

			// Verify logging occurred
			expect(consoleLogs.some(log => log.includes('LottoCheck: Starting jackpot check'))).toBe(true);
			expect(consoleLogs.some(log => log.includes('Mega Millions:'))).toBe(true);
			expect(consoleLogs.some(log => log.includes('Powerball:'))).toBe(true);

			// Restore console.log
			console.log = originalLog;
		});

		it('logs alert when threshold is exceeded', async () => {
			const consoleLogs = [];
			const originalLog = console.log;
			console.log = vi.fn((...args) => {
				consoleLogs.push(args.join(' '));
			});

			// Mock fetch with jackpots that exceed threshold
			const mockFetch = vi.fn();
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					json: () => Promise.resolve({
						d: JSON.stringify({
							Jackpot: { NextPrizePool: 2000000000 }, // $2B
							NextDrawingDate: '2025-12-26T00:00:00'
						})
					})
				})
			);
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					text: () => Promise.resolve(
						'<html>Estimated Jackpot: $1.80 Billion Next Drawing: Friday, December 27, 2024</html>'
					)
				})
			);
			global.fetch = mockFetch;

			const controller = { scheduledTime: Date.now(), cron: '0 20 * * *' };
			const ctx = createExecutionContext();

			await worker.scheduled(controller, { JACKPOT_THRESHOLD: '1500' }, ctx);

			// Verify alert was logged
			expect(consoleLogs.some(log => log.includes('ALERT:'))).toBe(true);
			expect(consoleLogs.some(log => log.includes('exceeded threshold'))).toBe(true);

			console.log = originalLog;
		});
	});
});

describe('Threshold checking', () => {
	it('correctly identifies when jackpots exceed threshold', async () => {
		const mockFetch = vi.fn();

		// Mock both APIs with high jackpots
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 2000000000 }, // $2B
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $1.80 Billion Next Drawing: Friday, December 27, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '1500' }, ctx);
		const data = await response.json();

		expect(data.megaMillions.exceedsThreshold).toBe(true);
		expect(data.powerball.exceedsThreshold).toBe(true);
		expect(data.threshold.exceeded).toBe(true);
		expect(data.threshold.exceedingLotteries).toContain('Mega Millions');
		expect(data.threshold.exceedingLotteries).toContain('Powerball');
	});

	it('correctly identifies when jackpots do not exceed threshold', async () => {
		const mockFetch = vi.fn();

		// Mock both APIs with low jackpots
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 }, // $500M
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $400 Million Next Drawing: Friday, December 27, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '1500' }, ctx);
		const data = await response.json();

		expect(data.megaMillions.exceedsThreshold).toBe(false);
		expect(data.powerball.exceedsThreshold).toBe(false);
		expect(data.threshold.exceeded).toBe(false);
		expect(data.threshold.exceedingLotteries).toHaveLength(0);
	});

	it('uses default threshold when env var is invalid', async () => {
		const mockFetch = vi.fn();

		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 1600000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $400 Million Next Drawing: Friday, December 27, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: 'invalid' }, ctx);
		const data = await response.json();

		// Default threshold is 1500, so 1600M should exceed it
		expect(data.threshold.amount).toBe(1500);
		expect(data.megaMillions.exceedsThreshold).toBe(true);
	});

	it('formats threshold display correctly for billions', async () => {
		const mockFetch = vi.fn();

		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $400 Million</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '1500' }, ctx);
		const data = await response.json();

		expect(data.threshold.display).toBe('$1.50 Billion');
	});

	it('formats threshold display correctly for millions', async () => {
		const mockFetch = vi.fn();

		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $400 Million</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '500' }, ctx);
		const data = await response.json();

		expect(data.threshold.display).toBe('$500 Million');
	});
});

describe('Mega Millions API', () => {
	it('correctly parses API response with billion jackpot', async () => {
		const mockFetch = vi.fn().mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 1700000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>Powerball data</html>')
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.lottery).toBe('Mega Millions');
		expect(data.megaMillions.jackpot).toContain('Billion');
		expect(data.megaMillions.jackpotAmount).toBe(1700);
		expect(data.megaMillions.nextDrawing).toMatch(/\w+, \w+ \d+, \d{4}/);
	});

	it('correctly parses API response with million jackpot', async () => {
		const mockFetch = vi.fn().mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 }, // $500M
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>Powerball data</html>')
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.lottery).toBe('Mega Millions');
		expect(data.megaMillions.jackpot).toContain('Million');
		expect(data.megaMillions.jackpotAmount).toBe(500);
	});

	it('handles API errors gracefully', async () => {
		const mockFetch = vi.fn().mockImplementationOnce(() =>
			Promise.reject(new Error('Network error'))
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>Powerball data</html>')
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.lottery).toBe('Mega Millions');
		expect(data.megaMillions.jackpot).toBe('Error');
		expect(data.megaMillions.jackpotAmount).toBe(0);
		expect(data.megaMillions.error).toBeDefined();
	});
});

describe('Powerball scraping', () => {
	it('correctly parses HTML with billion jackpot', async () => {
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $1.70 Billion Next Drawing: Friday, December 27, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toContain('Billion');
		expect(data.powerball.jackpotAmount).toBe(1700);
		expect(data.powerball.nextDrawing).toMatch(/\w+, \w+ \d+, \d{4}/);
	});

	it('correctly parses HTML with million jackpot', async () => {
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Jackpot: $450 Million Next Drawing: Wednesday, Dec 25, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toContain('Million');
		expect(data.powerball.jackpotAmount).toBe(450);
	});

	it('handles different HTML patterns', async () => {
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		// Alternative pattern without "Estimated" prefix
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>$1.20 Billion Wednesday, December 25, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.jackpotAmount).toBe(1200);
	});

	it('handles scraping errors gracefully', async () => {
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.reject(new Error('Network error'))
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toBe('Error');
		expect(data.powerball.jackpotAmount).toBe(0);
		expect(data.powerball.error).toBeDefined();
	});

	it('handles missing data in HTML', async () => {
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>No jackpot data here</html>')
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toBe('Not found');
		expect(data.powerball.jackpotAmount).toBe(0);
	});
});
