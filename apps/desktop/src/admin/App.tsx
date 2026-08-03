/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useAdminController } from './state/useAdminController';
import AdminWorkspace from './views/AdminWorkspace';

interface AppProps {
  onBack: () => void;
}

export default function App({ onBack }: AppProps) {
  const controller = useAdminController();
  return <AdminWorkspace onBack={onBack} controller={controller} />;
}
