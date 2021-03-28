import fs from 'fs'
import path from 'path'
import postcss from 'postcss'
import {gray} from 'sergeant'
import sqlite3 from 'sqlite3'
import stream from 'stream'
import {promisify} from 'util'

import {RAW} from '../css.js'
import {buildData} from './build-data.js'
import {createGetUniqueID} from './create-get-unique-id.js'
import {getHashOfFile} from './get-hash-of-file.js'
import {parse, PARSED} from './parse.js'
import {shorthandLonghands} from './shorthand-longhands.js'

const finished = promisify(stream.finished)
const mkdir = promisify(fs.mkdir)
const createWriteStream = fs.createWriteStream

export const compile = async (args) => {
  const dbinstance = new sqlite3.Database(':memory:')

  const db = {
    exec: promisify(dbinstance.exec.bind(dbinstance)),
    all: promisify(dbinstance.all.bind(dbinstance)),
    get: promisify(dbinstance.get.bind(dbinstance)),
    run: promisify(dbinstance.run.bind(dbinstance))
  }

  await db.exec(`
    CREATE TABLE name (
      id INTEGER PRIMARY KEY,
      name TEXT,
      namespace TEXT
    );

    CREATE TABLE decl (
      id INTEGER PRIMARY KEY,
      atruleID INTEGER,
      nameID INTEGER,
      pseudo TEXT,
      prop TEXT,
      value TEXT
    );

    CREATE TABLE atrule (
      id INTEGER PRIMARY KEY,
      parentAtruleID INTEGER,
      name TEXT
    );

    CREATE INDEX declAtrule ON decl(atruleID);
    CREATE INDEX atruleAtrule ON atrule(parentAtruleID);
    CREATE UNIQUE INDEX uniqueName ON name(name, namespace);
    CREATE UNIQUE INDEX uniqueDecl ON decl(atruleID, nameID, pseudo, prop);
    CREATE UNIQUE INDEX uniqueAtrule ON atrule(parentAtruleID, name);
  `)

  const cacheBustedInput = `${args.input}?${Date.now()}`

  const input = await import(cacheBustedInput)

  const inputStyles = {}

  for (const namespace of Object.keys(input)) {
    if (namespace.startsWith('_')) continue

    inputStyles[namespace] = parse(input[namespace]?.[RAW])
  }

  await mkdir(path.join(process.cwd(), args.output), {
    recursive: true
  })

  const outpath = path.join(
    process.cwd(),
    args.output,
    path.basename(args.input, path.extname(args.input))
  )

  const [cssHash, jsHash] = await Promise.all([
    getHashOfFile(`${outpath}.css`),
    getHashOfFile(`${outpath}.js`)
  ])

  const output = {
    cssHash,
    css: createWriteStream(`${outpath}.css`),
    jsHash,
    js: createWriteStream(`${outpath}.js`)
  }

  const css = postcss.parse('')

  const map = {}

  const addToMap = (namespace, name, id) => {
    if (map[namespace] == null) {
      map[namespace] = {}
    }

    if (map[namespace][name] == null) {
      map[namespace][name] = new Set()
    }

    map[namespace][name].add(id)
  }

  if (input?._start?.[RAW]) {
    const start = parse(input?._start?.[RAW])[PARSED]

    css.append(start)
  }

  const getUniqueID = createGetUniqueID(args['--prefix'] ?? '')

  for (const namespace of Object.keys(inputStyles)) {
    for (const name of Object.keys(inputStyles[namespace])) {
      const parsed = inputStyles[namespace][name]

      const context = {namespace, name, position: 0}

      for (const node of parsed) {
        await buildData(db, node, context)
      }
    }
  }

  const order = []

  if (input._atrules != null) {
    for (const key of Reflect.ownKeys(input._atrules)) {
      order.push(input._atrules[key])
    }
  }

  const nameMap = {}

  const buildCSS = async (searchID) => {
    let cssStr = ''

    const singles = await db.all(
      'SELECT name, nameID, namespace, prop, pseudo, value, GROUP_CONCAT(DISTINCT nameID) as nameIDs, GROUP_CONCAT(DISTINCT pseudo) as pseudos FROM decl LEFT JOIN name ON decl.nameID = name.id WHERE atruleID = ? GROUP BY atruleID, prop, value HAVING COUNT(decl.id) = 1 ORDER BY nameIDs, pseudos',
      searchID
    )

    let prevSingle

    if (singles.length) {
      let id

      for (const single of singles) {
        if (single.nameID !== prevSingle?.nameID) {
          if (!nameMap[single.nameIDs ?? single.nameID]) {
            id = getUniqueID()

            nameMap[single.nameIDs ?? single.nameID] = id

            addToMap(single.namespace, single.name, id)
          } else {
            id = nameMap[single.nameIDs ?? single.nameID]
          }
        }

        let semi = true

        if (
          single.nameID !== prevSingle?.nameID ||
          single.pseudo !== prevSingle?.pseudo
        ) {
          if (prevSingle != null) cssStr += `}`

          cssStr += `.${id}${single.pseudo}{`

          semi = false
        }

        cssStr += `${semi ? ';' : ''}${single.prop}:${single.value}`

        prevSingle = single
      }

      cssStr += `}`
    }

    const multis = await db.all(
      'SELECT atruleID, prop, value, GROUP_CONCAT(DISTINCT nameID) as nameIDs, GROUP_CONCAT(DISTINCT pseudo) as pseudos FROM decl WHERE atruleID = ? GROUP BY atruleID, prop, value HAVING COUNT(id) > 1 ORDER BY nameIDs, pseudos',
      searchID
    )

    let prevMulti

    if (multis.length) {
      for (const multi of multis) {
        let semi = true

        if (
          prevMulti?.nameIDs !== multi.nameIDs ||
          prevMulti?.pseudos !== multi.pseudos
        ) {
          const rules = await db.all(
            'SELECT namespace, name, pseudo, nameID FROM decl LEFT JOIN name ON decl.nameID = name.id WHERE atruleID = ? AND prop = ? AND value = ? ORDER BY pseudo, nameID',
            multi.atruleID,
            multi.prop,
            multi.value
          )

          if (prevMulti != null) cssStr += `}`

          let prevPseudo
          let id
          const selectors = []

          for (const rule of rules) {
            if (prevPseudo !== rule.pseudo) {
              id = getUniqueID()

              selectors.push(`.${id}${rule.pseudo}`)
            }

            addToMap(rule.namespace, rule.name, id)

            prevPseudo = rule.pseudo
          }

          cssStr += `${selectors.join(',')}{`

          semi = false
        }

        cssStr += `${semi ? ';' : ''}${multi.prop}:${multi.value}`

        prevMulti = multi
      }

      cssStr += `}`
    }

    const atrules = await db.all(
      'SELECT parentAtruleID, name, id FROM atrule WHERE parentAtruleID = ?',
      searchID
    )

    atrules.sort((a, b) => {
      const aIndex = order.indexOf(a.name)
      const bIndex = order.indexOf(b.name)

      if (aIndex === bIndex) {
        return 0
      }

      if (!~aIndex) {
        return -1
      }

      if (!~bIndex) {
        return 1
      }

      return aIndex - bIndex
    })

    for (let i = 0; i < atrules.length; i++) {
      const {name, id} = atrules[i]

      cssStr += `${name}{`

      cssStr += await buildCSS(id)

      cssStr += '}'
    }

    return cssStr
  }

  css.append(await buildCSS(0))

  await Promise.all(
    Object.entries(shorthandLonghands).map(async ([shorthand, longhands]) => {
      const rows = await db.all(
        `SELECT name.name, decl1.prop as shortProp, decl2.prop as longProp
          FROM name
            INNER JOIN decl as decl1 ON decl1.nameID = name.id
            INNER JOIN decl as decl2 ON decl1.nameID = decl2.nameID
          WHERE decl1.pseudo = decl2.pseudo
            AND decl1.prop = ?
            AND decl2.prop IN (${[...longhands].fill('?').join(', ')})
        `,
        shorthand,
        ...longhands
      )

      for (const row of rows) {
        console.warn(
          `${row.shortProp} found with ${row.longProp} for ${row.name}`
        )
      }
    })
  )

  css.append(input?._end?.[RAW] ? parse(input._end[RAW])?.[PARSED] : '')

  output.css.end(css.toResult().css)

  for (const namespace of Object.keys(map)) {
    for (const name of Object.keys(map[namespace])) {
      map[namespace][name] = Array.from(map[namespace][name]).join(' ')
    }

    if (args['--dev']) {
      output.js.write(`export const ${namespace} = new Proxy({${Object.entries(
        map[namespace]
      )
        .map(
          ([key, value]) =>
            `get [${JSON.stringify(key)}]() { return ${JSON.stringify(value)} }`
        )
        .join(',')}}, {
        get(target, prop) {
          if ({}.hasOwnProperty.call(target, prop)) {
            return '${namespace}:' + prop + ' ' + target[prop]
          }

          throw Error(\`\${prop} is undefined\`)
        }
      })\n`)
    } else {
      output.js.write(
        `export const ${namespace} = ${JSON.stringify(
          map[namespace],
          null,
          2
        )}\n`
      )
    }
  }

  output.js.end('')

  dbinstance.close()

  return Promise.all(
    ['css', 'js'].map((type) =>
      finished(output[type]).then(async () => {
        const hash = await getHashOfFile(`${outpath}.${type}`)

        if (hash !== output[`${type}Hash`]) {
          console.log(
            `${gray('[css]')} saved ${path.relative(
              process.cwd(),
              outpath
            )}.${type}`
          )
        }
      })
    )
  )
}
