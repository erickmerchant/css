import selectorTokenizer from 'css-selector-tokenizer'
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

    const shorts = await model.selectShorthandGroups(searchID)

    if (shorts.length) {
      let prevSelectors

      for (const short of shorts) {
        const shorthandItems = await model.selectItems(
          searchID,
          short.prop,
          short.value,
          short.nameIDs.split('-')
        )

        let prevItem
        let id
        let selectors = new Set()

        for (const item of shorthandItems) {
          if (
            prevItem == null ||
            prevItem.suffix !== item.suffix ||
            prevItem.repeat !== item.repeat
          ) {
            let suffix = ''

            if (item.suffix) {
              const selectorNodes = selectorTokenizer.parse(item.suffix).nodes

              for (const selector of selectorNodes[0].nodes) {
                if (selector.type === 'class') {
                  if (!nameMap[selector.name]) {
                    nameMap[selector.name] = getUniqueID()
                  }

                  addToMap(
                    item.namespace,
                    selector.name,
                    nameMap[selector.name]
                  )

                  selector.name = nameMap[selector.name]
                }
              }

              suffix = selectorTokenizer.stringify(selectorNodes[0])
            }

            if (!nameMap[short.nameIDs]) {
              id = getUniqueID()

              nameMap[short.nameIDs] = id

              addToMap(item.namespace, item.name, id)
            } else {
              id = nameMap[short.nameIDs]
            }

            selectors.add(
              `${Array(item.repeat).fill(`.${id}`).join('')}${suffix}`
            )
          }

          addToMap(item.namespace, item.name, id)

          prevItem = item
        }

        selectors = Array.from(selectors).join(',')

        if (prevSelectors !== selectors) {
          if (prevSelectors != null) {
            cssStr += '}'
          }

          cssStr += `${selectors}{`
        }

        cssStr += `${short.prop}:${short.value};`

        prevSelectors = selectors
      }

      cssStr += '}'
    }

    const singles = await model.selectSingles(searchID)

    let prevSingle

    if (singles.length) {
      let id

      for (const single of singles) {
        if (single.nameID !== prevSingle?.nameID) {
          if (!nameMap[single.nameID]) {
            id = getUniqueID()

            nameMap[single.nameID] = id

            addToMap(single.namespace, single.name, id)
          } else {
            id = nameMap[single.nameID]
          }
        }

        if (
          single.nameID !== prevSingle?.nameID ||
          single.suffix !== prevSingle?.suffix
        ) {
          if (prevSingle != null) cssStr += `}`

          let suffix = ''

          if (single.suffix) {
            const selectorNodes = selectorTokenizer.parse(single.suffix).nodes

            for (const selector of selectorNodes[0].nodes) {
              if (selector.type === 'class') {
                if (!nameMap[selector.name]) {
                  nameMap[selector.name] = getUniqueID()
                }

                addToMap(
                  single.namespace,
                  selector.name,
                  nameMap[selector.name]
                )

                selector.name = nameMap[selector.name]
              }
            }

            suffix = selectorTokenizer.stringify(selectorNodes[0])
          }

          cssStr += `${Array(single.repeat).fill(`.${id}`).join('')}${suffix}{`
        }

        cssStr += `${single.prop}:${single.value};`

        prevSingle = single
      }

      cssStr += `}`
    }

    const multis = await model.selectMultipleGroups(searchID)

    if (multis.length) {
      let prevSelectors

      for (const multi of multis) {
        const multipleItems = await model.selectItems(
          searchID,
          multi.prop,
          multi.value,
          multi.nameIDs.split('-')
        )

        let prevItem
        let id
        let selectors = new Set()

        for (const item of multipleItems) {
          if (
            prevItem == null ||
            prevItem.suffix !== item.suffix ||
            prevItem.repeat !== item.repeat
          ) {
            const key = `${multi.nameIDs} ${item.suffix} ${item.repeat}`

            if (!nameMap[key]) {
              id = getUniqueID()

              nameMap[key] = id

              addToMap(item.namespace, item.name, id)
            } else {
              id = nameMap[key]
            }

            let suffix = ''

            if (item.suffix) {
              const selectorNodes =
                selectorTokenizer.parse(item.suffix).nodes ?? []

              for (const selector of selectorNodes[0].nodes) {
                if (selector.type === 'class') {
                  if (!nameMap[selector.name]) {
                    nameMap[selector.name] = getUniqueID()
                  }

                  addToMap(
                    item.namespace,
                    selector.name,
                    nameMap[selector.name]
                  )

                  selector.name = nameMap[selector.name]
                }
              }

              suffix = selectorTokenizer.stringify(selectorNodes[0])
            }

            selectors.add(
              `${Array(item.repeat).fill(`.${id}`).join('')}${suffix}`
            )
          }

          addToMap(item.namespace, item.name, id)

          prevItem = item
        }

        selectors = Array.from(selectors).join(',')

        if (prevSelectors !== selectors) {
          if (prevSelectors != null) {
            cssStr += '}'
          }

          cssStr += `${selectors}{`
        }

        cssStr += `${multi.prop}:${multi.value};`

        prevSelectors = selectors
      }

      cssStr += '}'
    }

    const atrules = await model.selectAtrules(searchID)

    for (let i = 0; i < atrules.length; i++) {
      const {name, id} = atrules[i]

      cssStr += `${name}{${await buildCSS(id)}}`
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

  let i = 0

  let classesFactoryId = '_'

  while (map[classesFactoryId] != null) {
    classesFactoryId = `_${++i}`
  }

  output.js.write(`const ${classesFactoryId} = (map, props = []) => {
      let classes = []

      props = props.reduce((acc, prop) => {
        if (typeof prop === 'string') {
          acc.push(prop)
        } else {
          for (let i = 0, keys = Object.keys(prop); i < keys.length; i++) {
            if (prop[keys[i]]) {
              acc.push(keys[i])
            }
          }
        }

        return acc
      }, [])

      for (const prop of props) {
        ${
          args['--dev']
            ? `if (!{}.hasOwnProperty.call(map, prop)) {
              throw Error(prop + ' is undefined')
            }`
            : ''
        }

        classes.push(map[prop])
      }

      return classes.join(' ')
    }\n`)

  for (const namespace of Object.keys(map)) {
    for (const name of Object.keys(map[namespace])) {
      map[namespace][name] = Array.from(map[namespace][name]).join(' ')
    }

    if (args['--dev']) {
      output.js.write(`export const ${namespace} = new Proxy(
        (() => {
          const classes = (...props) => ${classesFactoryId}(classes, props)

          ${Object.entries(map[namespace])
            .map(
              ([key, value]) =>
                `Object.defineProperty(classes, ${JSON.stringify(key)}, {
                get() {
                  return ${JSON.stringify(value)}
                }
              })`
            )
            .join('\n')}

          return classes
        })(),
        {
          get(target, prop) {
            if ({}.hasOwnProperty.call(target, prop)) {
              return '${namespace}: ' + Reflect.get(...arguments)
            }

            throw Error(prop + ' is undefined')
          }
        }
      )\n`)
    } else {
      output.js.write(
        `export const ${namespace} = (() => {
          const classes = (...props) => ${classesFactoryId}(classes, props)

          ${Object.entries(map[namespace])
            .map(
              ([key, value]) =>
                `classes[${JSON.stringify(key)}] = ${JSON.stringify(value)}`
            )
            .join('\n')}

          return classes
        })()\n`
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
