import net from 'node:net'

/**
 * Answers whether something listens on a TCP port.
 *
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function tcpUp(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}
