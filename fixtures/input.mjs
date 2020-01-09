const desktop = '@media (min-width: 100px)'

const emphasis = `
  font-weight: normal;
  font-weight: bold;
  font-style: italic;
`

export default {
  _start: `
    p {
      margin-top: var(--spacing)
    }
  `,
  _atrules: [desktop],
  loud: `
    ${emphasis}
    ${desktop} {
      font-size: 5em;

      ::after {
        content: '!!'
      }
    }
    ::after {
      content: '!'
    }
  `,
  button: `
    ${emphasis}
    background: #ff8000;
    color: #111;
  `
}
