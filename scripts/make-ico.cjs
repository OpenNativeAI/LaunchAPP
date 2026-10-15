// 把多尺寸 PNG 打包成 PNG-in-ICO（Vista+ 支持），并分发到 build/ 与 resources/
const fs = require('fs')
const path = require('path')

const sizes = [16, 24, 32, 48, 64, 128, 256]
const dir = path.join(__dirname, 'icon-out')
const root = path.join(__dirname, '..')
const bufs = sizes.map((s) => fs.readFileSync(path.join(dir, `icon-${s}.png`)))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)

const entrySize = 16
let offset = header.length + entrySize * sizes.length
const entries = Buffer.alloc(entrySize * sizes.length)
sizes.forEach((s, i) => {
  const o = i * entrySize
  entries.writeUInt8(s >= 256 ? 0 : s, o)
  entries.writeUInt8(s >= 256 ? 0 : s, o + 1)
  entries.writeUInt8(0, o + 2)
  entries.writeUInt8(0, o + 3)
  entries.writeUInt16LE(1, o + 4)
  entries.writeUInt16LE(32, o + 6)
  entries.writeUInt32LE(bufs[i].length, o + 8)
  entries.writeUInt32LE(offset, o + 12)
  offset += bufs[i].length
})

fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, entries, ...bufs]))
fs.copyFileSync(path.join(dir, 'icon-256.png'), path.join(root, 'build', 'icon.png'))
fs.copyFileSync(path.join(dir, 'icon-32.png'), path.join(root, 'resources', 'icon.png'))
console.log('icon.ico / build/icon.png / resources/icon.png written')
