import { ActionFunctionArgs, redirect } from '@remix-run/node';
import { logger } from 'server/services/logger';
import { setGasCap } from 'server/store';

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const data = Object.fromEntries(formData) as { gasCap: string };
  const gasCap = data.gasCap;
  if (isNaN(Number(gasCap))) {
    logger.warn('⚠ Invalid gas cap', { data });
    return redirect('/');
  }
  await setGasCap(gasCap);
  logger.info(`📢 New gas cap has been set ${gasCap}`, { gasCap });
  return redirect('/');
}
