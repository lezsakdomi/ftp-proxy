const {FtpSrv, FileSystem: FtpSrvFileSystem} = require('ftp-srv')
const Client = require('ftp')
const Docker = require('dockerode')
const util = require('util')
const fs = require('fs')
const through2 = require('through2')

const ftpServer = new FtpSrv({
	url: process.env.LISTENING_URL || "ftp://127.0.0.1:21",
	pasv_url: process.env.PASSIVE_IP || "127.0.0.1",
	pasv_min: process.env.PASSIVE_PORT_FROM || 1024,
	pasv_max: process.env.PASSIVE_PORT_TO || 65535,
	timeout: 60 * 60 * 1000,
})
const docker = new Docker()

ftpServer.on('login', async ({connection, username, password}, resolve, reject) => {
	try {
		if (username.includes('@')) {
			// Split username and host and create a proxy to the specific virtual host
			const match = /(.+)@([^@:]+)(?::(\d+))?/.exec(username)
			if (match === null) {
				return reject(new Error("Username should be in format " +
					"`user@host[:port]` or just `host`"))
			} else {
				const [, user, providedHost, port] = match

				let host = undefined

				if (host === undefined && process.env.USE_DOCKER_VHOST) {
					for (let containerInfo of await docker.listContainers()) {
						const container = await docker.getContainer(containerInfo.Id)
						const inspectionResult = await container.inspect()
						if (inspectionResult.Config.Env.some(envvar => envvar === `VIRTUAL_HOST=${providedHost}`)) {
							host = inspectionResult.NetworkSettings.IPAddress
							break
						}
					}
				}

				if (process.env[`HOST_${providedHost}`]) {
					host = process.env[`HOST_${providedHost}`]
				}

				if (host === undefined && process.env.USE_USER_HOST) {
					host = providedHost
				}

				if (host === undefined) {
					return reject(new Error(`Domain name ${providedHost} is not hosted on this server.`))
				}

				const downstream = new Client()

				let loggedIn = false // todo parallel execution and race condition
				let lastError = {}

				connection.commandSocket.on('close', () => {
					downstream.destroy()
				})

				downstream.on('greeting', msg => {
					// todo something with received message
				}).on('ready', () => {
					resolve({fs: new FTPFS(connection, downstream)})
					loggedIn = true
				}).on('close', hadErr => {
					reject(lastError || new Error("Remote connection closed"
						+ (hadErr ? " with errors" : "")))
				}).on('end', () => {
					if (loggedIn) {
						reject(new Error("Connection closed"))
						connection.close(lastError)
					}
				}).on('error', err => {
					lastError = err
				})

				downstream.connect({
					host, port: port || 21,
					user, password,
				})
			}
		} else {
			// Use the username as the virtual host to connect to for browsing the root
			reject(new Error("Simply connecting to hosts is not implemented yet")) // todo implement
		}
	} catch (e) {
		return reject(e)
	}
})

class FTPFS extends FtpSrvFileSystem {
	constructor(upstream, downstream) {
		super(upstream)
		this.downstream = downstream
	}

	get getUniqueName() {
		return undefined
	}

	async get(fileName) {
		const stats = new Stats(this.downstream, fileName)
		return stats.propagate()
	}

	async currentDirectory() {
		return util.promisify(this.downstream.pwd).call(this.downstream)
	}

	async list(path) {
		// todo do just a simple LIST and prevent stat-ing every sub-item
		const list = await util.promisify(this.downstream.list).call(this.downstream, path)
		return Promise.all(list.map(entry => {
			const stats = new Stats(this.downstream, path + '/' + entry.name)
			return stats.propagate()
		}))
	}

	async chdir(path) {
		return util.promisify(this.downstream.cwd).call(this.downstream, path)
	}

	async write(fileName, {append, start}) {
		const stream = through2()
		if (start) await this.downstream.restart(start)
		this.downstream.put(stream, fileName, (err) => {
			if (err) {
				this.connection.log.error(err)
			}
		})
		return stream
	}

	async read(filename, {start}) {
		if (start) await this.downstream.restart(start)
		return util.promisify(this.downstream.get).call(this.downstream, filename)
	}

	async delete(path) {
		return util.promisify(this.downstream.delete).call(this.downstream, path)
	}

	async mkdir(path) {
		return util.promisify(this.downstream.mkdir).call(this.downstream, path)
	}

	async rename(from, to) {
		return util.promisify(this.downstream.rename).call(this.downstream, from, to)
	}

	async chmod(path, mode) {
		return util.promisify(this.downstream.site).call(this.downstream,
			`CHMOD ${mode >> 6}${(mode >> 3) % 8}${mode % 8} ${path}`)
	}
}

class Stats {
	constructor(connection, path) {
		this._connection = connection
		this.path = path
	}

	get connection() {
		return this._connection
	}

	get name() {
		const parts = this.path.split('/')
		return parts[parts.length - 1]
	}

	async propagate() {

		let isDirectory

		const cwd = await util.promisify(this.connection.pwd).call(this.connection)
		try {
			await util.promisify(this.connection.cwd).call(this.connection, this.path)
			isDirectory = true
		} catch (e) {
			if (e.code === 550) {
				// failed to cd into, probably a file
				isDirectory = false
			} else {
				throw e
			}
		}
		await util.promisify(this.connection.cwd).call(this.connection, cwd)

		if (isDirectory) {
			Object.setPrototypeOf(this, DirectoryStats.prototype)
		} else {
			Object.setPrototypeOf(this, FileStats.prototype)
		}

		return this.propagate()
	}
}

class FileStats extends Stats {
	async propagate() {
		const list = await util.promisify(this.connection.list).call(this.connection, this.path)

		if (list.length === 1) {
			const entry = list[0]

			this.size = entry.size
			this.mtime = entry.date
			this.mode = [
				entry.rights.user,
				entry.rights.group,
				entry.rights.other,
			].reduce((a, v) => {
				return (a << 3)
					+ (v.includes('r') ? 4 : 0)
					+ (v.includes('w') ? 2 : 0)
					+ (v.includes('x') ? 1 : 0)
			}, 0)
			this.uid = entry.owner
			this.gid = entry.group

			if (this.size === undefined) {
				this.size = await util.promisify(this.connection.size)
					.call(this.connection, this.path)
			}

			if (this.mtime === undefined) {
				this.mtime = await util.promisify(this.connection.lastMod)
					.call(this.connection, this.path)
			}
		} else if (list.length > 1) {
			// heh, it's definitely a directory. Fix that!
			Object.setPrototypeOf(this, DirectoryStats.prototype)
			return this.propagate()
		} else {
			// probably insufficent permissions
			this.size = 0
			this.mtime = new Date(0)
			this.mode = 0
			this.uid = "notu"
			this.gid = "notu"
		}

		this.propagate = function () {
			return this
		}

		return this
	}

	isDirectory() {
		return false
	}
}

class DirectoryStats extends Stats {
	async propagate() {
		// todo do it, not just simulate
		this.size = 1
		this.mtime = new Date()

		this.propagate = function () {
			return this
		}

		return this
	}

	isDirectory() {
		return true
	}
}

ftpServer.listen()