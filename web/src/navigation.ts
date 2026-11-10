import { CalendarDays, Refrigerator, ShoppingBasket, Sparkles, Users } from 'lucide-react';
import type { NavItem } from './ui';

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'suggest', label: 'Suggest', href: '/', icon: Sparkles },
  { id: 'plans', label: 'Plans', href: '/plans', icon: CalendarDays },
  { id: 'grocery', label: 'Grocery', href: '/grocery', icon: ShoppingBasket },
  { id: 'fridge', label: 'Fridge', href: '/fridge', icon: Refrigerator },
  { id: 'household', label: 'Household', href: '/households', icon: Users },
];

/** The nav item for a path: `/` matches only itself, others match by prefix. */
export function activeNavId(pathname: string): string | undefined {
  const match = NAV_ITEMS.find((item) =>
    item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return match?.id;
}
