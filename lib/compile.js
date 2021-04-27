import fs from 'fs'
import path from 'path'
import postcss from 'postcss'
import postcssSortMediaQueries from 'postcss-sort-media-queries'
import {gray} from 'sergeant'
import stream from 'stream'
import {promisify} from 'util'

import {RAW} from '../css.js'
import {buildData} from './build-data.js'
import {createGetUniqueID} from './create-get-unique-id.js'
import {getHashOfFile} from './get-hash-of-file.js'
import * as model from './model.js'
import {parse} from './parse.js'

const finished = promisify(stream.finished)
const mkdir = promisify(fs.mkdir)
const createWriteStream = fs.createWriteStream

export const compile = async (args) => {
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
    const start = parse(input?._start?.[RAW]).parsed

    css.append(start)
  }

  const getUniqueID = createGetUniqueID(args['--prefix'] ?? '')

  for (const namespace of Object.keys(inputStyles)) {
    if (inputStyles[namespace].error) {
      throw inputStyles[namespace].error
    }

    for (const [name, parsed] of Object.entries(
      inputStyles[namespace].classes
    )) {
      const context = {namespace, name, position: 0}

      for (const node of parsed) {
        await buildData(node, context)
      }
    }
  }

  const nameMap = {}

  const buildCSS = async (searchID) => {
    let cssStr = ''

    const singles = await model.selectSingles(searchID)

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
          single.suffix !== prevSingle?.suffix
        ) {
          if (prevSingle != null) cssStr += `}`

          cssStr += `.${id}${single.suffix}{`

          semi = false
        }

        cssStr += `${semi ? ';' : ''}${single.prop}:${single.value}`

        prevSingle = single
      }

      cssStr += `}`
    }

    const multis = await model.selectMultiples(searchID)

    let prevMulti

    if (multis.length) {
      for (const multi of multis) {
        let semi = true

        if (
          prevMulti?.nameIDs !== multi.nameIDs ||
          prevMulti?.suffixes !== multi.suffixes
        ) {
          const rules = await model.rules(
            multi.atruleID,
            multi.prop,
            multi.value
          )

          if (prevMulti != null) cssStr += `}`

          let prevSuffix
          let id
          const selectors = []

          for (const rule of rules) {
            if (prevSuffix !== rule.suffix) {
              id = getUniqueID()

              selectors.push(`.${id}${rule.suffix}`)
            }

            addToMap(rule.namespace, rule.name, id)

            prevSuffix = rule.suffix
          }

          cssStr += `${selectors.join(',')}{`

          semi = false
        }

        cssStr += `${semi ? ';' : ''}${multi.prop}:${multi.value}`

        prevMulti = multi
      }

      cssStr += `}`
    }

    const atrules = await model.atrules(searchID)

    for (let i = 0; i < atrules.length; i++) {
      const {name, id} = atrules[i]

      cssStr += `${name}{`

      cssStr += await buildCSS(id)

      cssStr += '}'
    }

    return cssStr
  }

  css.append(await buildCSS(0))

  css.append(input?._end?.[RAW] ? parse(input._end[RAW])?.parsed : '')

  output.css.end(
    (
      await postcss([postcssSortMediaQueries]).process(css, {
        from: 'styles.css'
      })
    ).css
  )

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
