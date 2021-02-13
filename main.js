//@ts-check
const { spawn } = require('child_process')
const { on } = require('events')
const http = require('http')

const async_hooks = require('async_hooks')

const stackMap = new Map()

async_hooks.createHook({ init }).enable()

Error.stackTraceLimit = Infinity;

function init(asyncId, type, triggerAsyncId) {
  const parentStack = stackMap.get(triggerAsyncId) || ''
  let currentStack = {}
  Error.captureStackTrace(currentStack)
  stackMap.set(asyncId, currentStack.stack + '\n' + parentStack)
}

global.makeError = function (ctor, ...args) {
  const err = new ctor(...args)
  err.stack += '\n' + stackMap.get(async_hooks.executionAsyncId())
  return err
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// SHARED FUNCTIONS
///////////////////////////////////////////////////////////////////////////////////////////////////
const PROGRESS_OUT_OF = 30
async function progressTo(size) {
	process.stdout.write('\x1B[?25l')

	process.stdout.write('|')
	for (let i = 0; i < PROGRESS_OUT_OF; i++) {
		process.stdout.write(' ')
	}
	process.stdout.write('|\n')

	const sleepPart = size / PROGRESS_OUT_OF

	process.stdout.write('|')
	for (let i = 0; i < PROGRESS_OUT_OF; i++) {
		await sleep(sleepPart)
		process.stdout.write('=')
	}
	process.stdout.write('|')
	process.stdout.write(' 💯%\n')
}

function sleep(timeSec) {
	return new Promise((resolve) => setTimeout(() => resolve(), timeSec * 1000))
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// APP TESTER SECTION
///////////////////////////////////////////////////////////////////////////////////////////////////
function send(msg = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: 'localhost',
				path: msg.end ? '/end' : '/',
				port: '3000',
				method: 'POST',
			},
			(res) => {
				var str = []
				res.on('data', (chunk) => str.push(chunk))
				res.on('end', () => resolve(JSON.parse(str.join())))
			}
		)
		req.write(JSON.stringify(msg))
		req.on('error', (error) => reject(error))
		req.end()
	})
}

async function test(args) {
	console.log(new Date(), '🤨 testing...')

	const ERROR_SLEEP_TIME = 30 // 1355 // 2710, 3600

	const app = spawn('node', [__filename, 'child'], { stdio: 'inherit' })
	await sleep(1)

	console.log(await send())

	let notFailed = true
	do {
		app.kill('SIGSTOP')
		console.log(new Date(), `😴 SIGSTOP driver app for ${ERROR_SLEEP_TIME} seconds`)

		await progressTo(ERROR_SLEEP_TIME)

		console.log(new Date(), `👀 SIGCONT driver app`)
		app.kill('SIGCONT')

		const res = await send()

		console.dir(res)

		notFailed = res !== 'Current topology does not support sessions'
	} while (notFailed)

	await send({end: true})

	return 'done.'
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// DRIVER APP
///////////////////////////////////////////////////////////////////////////////////////////////////
async function testSessions(client) {
	let res
	let session

	try {
		session = client.startSession()
		await session.withTransaction(async () => {})
		res = { success: true }
	} catch (e) {
		res = e.message
		// console.log(util.inspect(client.topology.description, { colors: true, depth: 6 }));
	} finally {
		if (session) {
			session.endSession()
			session = undefined
		}
		return res
	}
}

async function main(args) {
	const { MongoClient } = require('.')
	const viz = require('./test/tools/utils').visualizeMonitoringEvents


	let i = 0
	const server = http.createServer().listen(3000)
	const MONGODB_URI =
	  process.env.MONGODB_URI
	  || 'mongodb://localhost:31000,localhost:31001,localhost:31002/?replicaSet=rs'

	let client = new MongoClient(MONGODB_URI, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
		ignoreUndefined: true,
	})

	viz(client)

	await client.connect()

	console.log(new Date(), '🙉 listening...')
	for await (const [req, res] of on(server, 'request')) {
		const url = new URL(req.url, `http://${req.headers.host}`)
		console.log(new Date(), `request ${i++} ${url}`)

		if (url.pathname === '/end') {
			res.end(JSON.stringify({ bye: true }) + '\n')
			break
		}

		const testResult = await testSessions(client)

		res.setHeader('Content-Type', 'application/json')
		res.statusCode = 200
		res.end(JSON.stringify(testResult) + '\n')
	}

	console.log('ending...')
	await client.close()
	await new Promise((resolve, reject) => {
		server.close((err) => {
			if(err) reject(err)
			console.log('server closed...')
			resolve()
		})
	})

	return 'done.'
}


///////////////////////////////////////////////////////////////////////////////////////////////////
// START UP SECTION
///////////////////////////////////////////////////////////////////////////////////////////////////
if (process.argv[2] === 'child') {
	// DRIVER TEST APP
	main(process.argv).then(console.log).catch(console.error)
} else {
	// APP TESTER
	test(process.argv).then(console.log).catch(console.error)
}
