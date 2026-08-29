import customerAvatar from '../assets/customer-avatar.svg';
import customerServiceAvatar from '../assets/customer-service-avatar.svg';
import { useEffect, useState } from 'react';

interface CustomerAvatarProps {
  name: string;
  size?: 'list' | 'header' | 'message';
  type?: 'customer' | 'service';
  src?: string | null;
}

export default function CustomerAvatar({ name, size = 'list', type = 'customer', src = null }: CustomerAvatarProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const sizeClass = size === 'header' ? 'w-10 h-10' : size === 'message' ? 'w-10 h-10' : 'w-12 h-12';
  const avatarSrc = src && !failed ? src : type === 'service' ? customerServiceAvatar : customerAvatar;
  const avatarLabel = type === 'service' ? '客服头像' : '客户头像';

  return (
    <img
      src={avatarSrc}
      alt={`${name}的${avatarLabel}`}
      onError={() => setFailed(true)}
      className={`${sizeClass} rounded-full object-cover flex-shrink-0`}
      referrerPolicy="no-referrer"
    />
  );
}
