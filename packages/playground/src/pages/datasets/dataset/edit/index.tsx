import { EditDatasetPage as SharedEditDatasetPage } from '@mastra/playground-ui/domains/datasets';
import { useLocale } from '@mastra/playground-ui/lib/i18n';
import { useNavigate, useParams } from 'react-router';

function EditDatasetPage() {
  useLocale();
  const { datasetId } = useParams() as { datasetId: string };
  const navigate = useNavigate();
  return (
    <SharedEditDatasetPage
      datasetId={datasetId}
      datasetsHref="/datasets"
      onDone={() => void navigate(`/datasets/${datasetId}`)}
    />
  );
}

export { EditDatasetPage };
export default EditDatasetPage;
