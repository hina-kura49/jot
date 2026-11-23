import mark from '@/assets/brand/jot-mark.png'

/** Jot の印。アプリのアイコン(src-tauri/app-icon.png。icons/ はここから `npx tauri icon` で作る)を小さくしたもの */
export function JotMark({ size = 22 }: { size?: number }) {
  return <img src={mark} width={size} height={size} alt="" aria-hidden className="shrink-0" draggable={false} />
}
