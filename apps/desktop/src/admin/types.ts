export type NavItem = {
  id: string;
  label: string;
  icon: string;
};

export type DashboardStat = {
  title: string;
  value: string | number;
  change: string;
  trend: 'up' | 'down' | 'neutral';
  description: string;
};
