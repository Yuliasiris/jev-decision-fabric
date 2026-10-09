/** Read exactly the runtime's advertised definitions, including OAuth metadata.
 * Both existing finite-plan flags describe this prepared two-tool distribution.
 * This generator does not alter flags, authenticate, or invoke a provider.
 */
import {tools} from '../netlify/lib/app.mts';
const preparedTwoTools = (key: string) =>
  ['JEV_FABRIC_ENABLED', 'JEV_FABRIC_PLAN_ENABLED'].includes(key) ? 'true' : undefined;
console.log(JSON.stringify({tools: tools(preparedTwoTools)}, null, 2));
