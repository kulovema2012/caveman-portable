// Function-hook version of the caveman icon, for comparison with the MessageDisplay command hook.
//
// The command hook starts a Node process for every streamed batch (~110 ms each). This runs in the engine's
// hooks worker instead, so there is no process to start. It rewrites the render input's props rather than
// building a UI tree, which keeps it independent of the element factory.
//
// AssistantMessage render input carries props.text and props.isFirstOfReply, so the badge lands once per
// reply rather than once per line.
export function register(on) {
  // The engine interface is the first parameter; this hook needs only the event and the continuation.
  on('ui.render', { component: 'AssistantMessage' }, (_engine, e, next) => {
    // Proven on 2026-09-16: this fires on real replies (the comparison run showed its marker next to the
    // command hook's). Run only one of the two, or every reply carries two icons.
    const props = e?.props;
    if (!props || props.isFirstOfReply !== true || typeof props.text !== 'string' || props.text.includes('\u{1FAA8}')) {
      return next(e);
    }
    return next({ ...e, props: { ...props, text: `\u{1FAA8} ${props.text}` } });
  });
}
