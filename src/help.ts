// The small "i" buttons that explain a number. Each is a <details class="metric-help">: it opens on
// hover with a mouse, on click or tap, and from the keyboard, and closes on Escape or a press outside.
export function initHelp(root: ParentNode = document): void {
  for (const help of root.querySelectorAll<HTMLDetailsElement>('.metric-help')) {
    let previewing = false;
    const close = () => {
      previewing = false;
      help.open = false;
    };

    help.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse' || help.open) return;
      previewing = true;
      help.open = true;
    });

    help.addEventListener('pointerleave', () => {
      if (previewing) close();
    });

    help.querySelector('summary')?.addEventListener('click', (event) => {
      if (!previewing) return;
      event.preventDefault();
      previewing = false;
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && help.open) close();
    });

    document.addEventListener('pointerdown', (event) => {
      if (help.open && event.target instanceof Node && !help.contains(event.target)) close();
    });
  }
}
