const _import = require('esm')(module)
const path = require('path')
const fs = require('fs')
const stream = require('stream')
const promisify = require('util').promisify
const postcss = require('postcss')
const selectorTokenizer = require('css-selector-tokenizer')
const finished = promisify(stream.finished)
const mkdir = promisify(fs.mkdir)
const createWriteStream = fs.createWriteStream

const unsupportedShorthands = {
  animation: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'],
  background: ['background-clip', 'background-color', 'background-image', 'background-origin', 'background-position', 'background-repeat', 'background-size', 'background-attachment'],
  border: ['border-bottom-width', 'border-bottom-style', 'border-bottom-color', 'border-left-width', 'border-left-style', 'border-left-color', 'border-right-width', 'border-right-style', 'border-right-color', 'border-top-width', 'border-top-style', 'border-top-color', 'border-color', 'border-style', 'border-width'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'column-rule': ['column-rule-width', 'column-rule-style', 'column-rule-color'],
  columns: ['column-width', 'column-count'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  font: ['font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family'],
  grid: ['grid-template-rows', 'grid-template-columns', 'grid-template-areas', 'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow'],
  'grid-area': ['grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],
  'list-style': ['list-style-type', 'list-style-image', 'list-style-position'],
  offset: ['offset-position', 'offset-path', 'offset-distance', 'offset-rotate', 'offset-anchor'],
  outline: ['outline-style', 'outline-width', 'outline-color'],
  'place-content': ['align-content', 'justify-content'],
  'place-items': ['align-items', 'justify-items'],
  'place-self': ['align-self', 'justify-self'],
  'text-decoration': ['text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay']
}

const supportedShorthands = {
  'border-color': require('./lib/shorthands/border-color.js'),
  'border-radius': require('./lib/shorthands/border-radius.js'),
  'border-style': require('./lib/shorthands/border-style.js'),
  'border-width': require('./lib/shorthands/border-width.js'),
  margin: require('./lib/shorthands/margin.js'),
  overflow: require('./lib/shorthands/overflow.js'),
  padding: require('./lib/shorthands/padding.js')
}

const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

const letterCount = letters.length

const isEqualArray = (a, b) => {
  if (a.length !== b.length) return false

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }

  return true
}

const processNodes = (nodes, selector = '', template = '{}') => {
  let results = {}

  for (const node of nodes) {
    if (node.type === 'decl') {
      if (supportedShorthands[node.prop]) {
        const expanded = supportedShorthands[node.prop].expand(node.value)

        if (expanded) {
          for (const [prop, value] of Object.entries(expanded)) {
            results[`${template} ${selector} ${prop}`] = {
              template,
              selector,
              prop,
              value
            }
          }

          continue
        }
      }

      const prop = node.prop
      const value = node.value

      results[`${template} ${selector} ${prop}`] = {
        template,
        selector,
        prop,
        value
      }
    } else if (node.type === 'atrule') {
      results = {
        ...results,
        ...processNodes(node.nodes, selector, template.replace('{}', `{ @${node.name} ${node.params} {} }`))
      }
    } else if (node.type === 'rule') {
      if (selector) throw Error('nested rule found')

      const parsed = selectorTokenizer.parse(node.selector)

      for (const n of parsed.nodes) {
        if (n.nodes.filter((n) => n.type === 'spacing' || n.type.includes('pseudo')).length !== n.nodes.length) {
          throw Error('non-pseudo selector found')
        }

        results = {
          ...results,
          ...processNodes(node.nodes, selectorTokenizer.stringify(n).trim(), template)
        }
      }
    }
  }

  return results
}

const processSelectors = (node) => {
  const results = []

  if (node.nodes) {
    for (const n of node.nodes) {
      if (n.type === 'class') {
        results.push(n.name)
      }

      if (n.nodes) {
        results.push(...processSelectors(n))
      }
    }
  }

  return results
}

const run = async (args) => {
  let id = 0
  const existingIds = []

  const uniqueId = () => {
    let result = ''

    do {
      let i = id++
      result = ''

      let r

      do {
        r = i % letterCount
        i = (i - r) / letterCount

        result += letters[r]
      } while (i)
    } while (existingIds.includes(result))

    return result
  }

  const input = _import(`${args.input}?${Date.now()}`)

  await mkdir(path.dirname(path.join(process.cwd(), args.output)), {recursive: true})

  const output = {
    css: createWriteStream(path.join(process.cwd(), `${args.output}.css`)),
    js: createWriteStream(path.join(process.cwd(), `${args.output}.mjs`))
  }

  const map = {}
  const tree = {}
  const ids = {}

  if (input._start) {
    output.css.write(input._start)

    postcss.parse(input._start).walkRules((rule) => {
      const parsed = selectorTokenizer.parse(rule.selector)

      existingIds.push(...processSelectors(parsed))
    })
  }

  if (input._end) {
    postcss.parse(input._end).walkRules((rule) => {
      const parsed = selectorTokenizer.parse(rule.selector)

      existingIds.push(...processSelectors(parsed))
    })
  }

  for (const [name, raw] of Object.entries(input.styles)) {
    const parsed = postcss.parse(raw)
    const processed = Object.values(processNodes(parsed.nodes))
    const bannedLonghands = {}

    for (const {template, selector, prop} of processed) {
      if (unsupportedShorthands[prop] != null) {
        if (bannedLonghands[`${template} ${selector}`] == null) {
          bannedLonghands[`${template} ${selector}`] = []
        }

        bannedLonghands[`${template} ${selector}`].push(...unsupportedShorthands[prop])
      }
    }

    for (const {template, selector, prop, value} of processed) {
      if (bannedLonghands[`${template} ${selector}`] != null) {
        if (bannedLonghands[`${template} ${selector}`].includes(prop)) {
          console.warn(`${prop} found with shorthand`)
        }
      }

      tree[template] = tree[template] || []

      const index = tree[template].findIndex((r) => r.selector === selector && r.prop === prop && r.value === value)

      if (index < 0) {
        tree[template].push({
          names: [name],
          selector,
          prop,
          value
        })
      } else {
        tree[template][index].names.push(name)
      }
    }
  }

  for (const template of Object.keys(tree)) {
    const branch = tree[template]
    const remainders = {}
    const rules = []

    while (branch.length) {
      const {selector, prop, value, names} = branch.shift()

      if (names.length > 1) {
        const cls = uniqueId()

        const decls = {
          [prop]: value
        }

        let i = 0

        while (i < branch.length) {
          if (isEqualArray(branch[i].names, names) && branch[i].selector === selector) {
            decls[branch[i].prop] = branch[i].value

            branch.splice(i, 1)
          } else {
            i++
          }
        }

        for (const shorthand of Object.values(supportedShorthands)) {
          shorthand.collapse(decls)
        }

        rules.push(`.${cls}${selector} { ${Object.keys(decls).map((prop) => `${prop}: ${decls[prop]}`).join('; ')}; }`)

        for (const name of names) {
          map[name] = map[name] || []

          map[name].push(cls)
        }
      } else {
        const name = names[0]

        if (remainders[`${selector} ${name}`] == null) {
          remainders[`${selector} ${name}`] = {
            selector,
            name,
            decls: {}
          }
        }

        remainders[`${selector} ${name}`].decls[prop] = value
      }
    }

    for (const {selector, name, decls} of Object.values(remainders)) {
      const cls = ids[name] || uniqueId()

      ids[name] = cls

      for (const shorthand of Object.values(supportedShorthands)) {
        shorthand.collapse(decls)
      }

      rules.push(`.${cls}${selector} { ${Object.keys(decls).map((prop) => `${prop}: ${decls[prop]}`).join('; ')}; }`)

      map[name] = map[name] || []

      if (!map[name].includes(cls)) {
        map[name].push(cls)
      }
    }

    const line = template.replace('{}', `{ ${rules.join('')} }`)

    output.css.write(line.substring(2, line.length - 2))
  }

  output.css.end(input._end != null ? input._end : '')

  for (const name of Object.keys(map)) {
    map[name] = map[name].join(' ')
  }

  output.js.end(`export const classes = ${JSON.stringify(map, null, 2)}`)

  return Promise.all([
    finished(output.css),
    finished(output.js)
  ])
}

module.exports = (args) => {
  args.input = path.join(process.cwd(), args.input)

  if (!args.watch) {
    return run(args)
  }

  run(args)

  let changed = false

  fs.watch(args.input, () => {
    if (!changed) {
      changed = true

      setTimeout(() => {
        run(args)

        changed = false
      }, 100)
    }
  })
}
