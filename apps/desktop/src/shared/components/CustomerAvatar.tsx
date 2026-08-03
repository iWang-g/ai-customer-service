import customerAvatar from '../assets/customer-avatar.svg';
import customerServiceAvatar from '../assets/customer-service-avatar.svg';

interface CustomerAvatarProps {
  name: string;
  size?: 'list' | 'header' | 'message';
  type?: 'customer' | 'service';
}

export default function CustomerAvatar({ name, size = 'list', type = 'customer' }: CustomerAvatarProps) {
  const sizeClass = size === 'header' ? 'w-10 h-10' : size === 'message' ? 'w-8 h-8' : 'w-12 h-12';
  const avatarSrc = type === 'service' ? customerServiceAvatar : customerAvatar;
  const avatarLabel = type === 'service' ? '客服头像' : '客户头像';

  return (
    <img
      src={avatarSrc}
      alt={`${name}的${avatarLabel}`}
      className={`${sizeClass} rounded-full object-cover flex-shrink-0`}
    />
  );
}
