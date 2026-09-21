import qianniuLogo from './qianniu_logo.svg';
import pddLogo from './pdd_logo.svg';
import doudianLogo from './doudian_logo.svg';

const names: Record<string, string> = { pinduoduo: '拼多多', douyin: '抖店', qianniu: '千牛' };
const logos: Record<string, string> = { qianniu: qianniuLogo, pinduoduo: pddLogo, douyin: doudianLogo };
export const platformName = (code: string) => names[code] || code;

export default function PlatformLogo({ code }: { code: string }) {
  const src = logos[code];
  return src ? <img className="notice-logo" src={src} alt={platformName(code)} />
    : <span className="notice-logo notice-logo-fallback" aria-label={platformName(code)}>{platformName(code).slice(0, 1)}</span>;
}
