import FpaDraftGuard from '../../../components/FpaDraftGuard';

export default function AdminFpaLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FpaDraftGuard />
      {children}
    </>
  );
}
