import { Dialog, type DialogProps } from './Dialog';

export type SheetProps = Omit<DialogProps, 'placement'>;

/**
 * Bottom sheet on phones and a right-hand side panel from the `lg`
 * breakpoint. Same focus and close behavior as Dialog.
 */
export function Sheet(props: SheetProps) {
  return <Dialog {...props} placement="sheet" />;
}
