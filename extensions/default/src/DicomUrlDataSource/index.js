import { DicomMetadataStore, IWebApiDataSource } from '@ohif/core';
import OHIF from '@ohif/core';
import axios from 'axios';

import getImageId from '../DicomWebDataSource/utils/getImageId';
import getDirectURL from '../utils/getDirectURL';
import filesToStudies from '../../../../platform/app/src/routes/Local/filesToStudies';
const { EVENTS } = DicomMetadataStore;

const metadataProvider = OHIF.classes.MetadataProvider;

let _store = {
  urls: [],
  studyInstanceUIDMap: new Map(), // map of urls to array of study instance UIDs
  instances: [{}],
};

function createDicomUrlApi(dicomUrlConfig) {
  const implementation = {
    initialize: async ({ query, url }) => {
      if (!url) {
        url = query.get('url');
      }

      const response = await fetch(url);
      const data = await response.json();

      let instancesData = [];

      data.studies.forEach(study => {
        study.series.forEach(series => {
          series.instances.forEach(instance => {
            instancesData.push({ StudyInstanceUID: study.StudyInstanceUID, instance });
          });
        });
      });

      _store.urls.push({
        url,
        studies: [...data.studies],
      });
      _store.studyInstanceUIDMap.set(
        url,
        data.studies.map(study => study.StudyInstanceUID)
      );

      _store.instances.push(...instancesData);
    },
    query: {
      studies: {
        mapParams: () => {},
        search: async param => {
          const studyUIDs = DicomMetadataStore.getStudyInstanceUIDs();

          return studyUIDs.map(studyUid => {
            const study = DicomMetadataStore.getStudy(studyUid);
            return {
              accession: study.AccessionNumber,
              date: study.StudyDate,
              description: study.StudyDescription,
              instances: study.NumInstances,
              modalities: study.Modalities,
              mrn: study.PatientID,
              patientName: study.PatientName,
              studyInstanceUid: study.StudyInstanceUID,
              NumInstances: study.NumInstances,
              time: study.StudyTime,
            };
          });
        },
        processResults: () => {
          console.warn(' DICOMUrl QUERY processResults not implemented');
        },
      },
      series: {
        // mapParams: mapParams.bind(),
        search: () => {
          console.warn(' DICOMUrl QUERY SERIES SEARCH not implemented');
        },
      },
      instances: {
        search: () => {
          console.warn(' DICOMUrl QUERY instances SEARCH not implemented');
        },
      },
    },
    retrieve: {
      /**
       * Generates a URL that can be used for direct retrieve of the bulkdata
       *
       * @param {object} params
       * @param {string} params.tag is the tag name of the URL to retrieve
       * @param {string} params.defaultPath path for the pixel data url
       * @param {object} params.instance is the instance object that the tag is in
       * @param {string} params.defaultType is the mime type of the response
       * @param {string} params.singlepart is the type of the part to retrieve
       * @param {string} params.fetchPart unknown?
       * @returns an absolute URL to the resource, if the absolute URL can be retrieved as singlepart,
       *    or is already retrieved, or a promise to a URL for such use if a BulkDataURI
       */
      directURL: params => {
        return getDirectURL(dicomUrlConfig, params);
      },
      series: {
        metadata: async ({ StudyInstanceUID, madeInClient = false, customSort } = {}) => {
          if (!StudyInstanceUID) {
            throw new Error('Unable to query for SeriesMetadata without StudyInstanceUID');
          }

          const studyInstancesToRetrieve = _store.instances.filter(
            i => i.StudyInstanceUID === StudyInstanceUID
          );

          const filePromises = studyInstancesToRetrieve.map(async instance => {
            const response = await axios({
              url: instance.instance.url.replace('dicomweb:', ''),
              method: 'GET',
              responseType: 'blob',
              headers: {
                Accept: 'application/dicom',
              },
            });

            const blob = response.data;
            return new File([blob], instance.instance.name, { type: 'application/dicom' });
          });

          const files = await Promise.all(filePromises);
          await filesToStudies(files);

          const study = DicomMetadataStore.getStudy(StudyInstanceUID);

          study.series.forEach(aSeries => {
            const { SeriesInstanceUID } = aSeries;

            const isMultiframe = aSeries.instances[0].NumberOfFrames > 1;

            aSeries.instances.forEach((instance, index) => {
              const {
                url: imageId,
                StudyInstanceUID,
                SeriesInstanceUID,
                SOPInstanceUID,
              } = instance;

              instance.imageId = imageId;

              // Add imageId specific mapping to this data as the URL isn't necessarily WADO-URI.
              metadataProvider.addImageIdToUIDs(imageId, {
                StudyInstanceUID,
                SeriesInstanceUID,
                SOPInstanceUID,
                frameIndex: isMultiframe ? index : 1,
              });
            });

            DicomMetadataStore._broadcastEvent(EVENTS.INSTANCES_ADDED, {
              StudyInstanceUID,
              SeriesInstanceUID,
              madeInClient,
            });
          });
        },
      },
    },
    store: {
      dicom: () => {
        console.warn(' DicomUrl store dicom not implemented');
      },
    },
    getImageIdsForDisplaySet(displaySet) {
      const images = displaySet.images;
      const imageIds = [];

      if (!images) {
        return imageIds;
      }

      displaySet.images.forEach(instance => {
        const NumberOfFrames = instance.NumberOfFrames;

        if (NumberOfFrames > 1) {
          for (let i = 0; i < NumberOfFrames; i++) {
            const imageId = getImageId({
              instance,
              frame: i,
              config: dicomUrlConfig,
            });
            imageIds.push(imageId);
          }
        } else {
          const imageId = getImageId({ instance, config: dicomUrlConfig });
          imageIds.push(imageId);
        }
      });

      return imageIds;
    },
    getImageIdsForInstance({ instance, frame }) {
      const imageIds = getImageId({ instance, frame });
      return imageIds;
    },
    deleteStudyMetadataPromise() {
      console.log('deleteStudyMetadataPromise not implemented');
    },
    getStudyInstanceUIDs: ({ params, query }) => {
      const url = query.get('url');
      return _store.studyInstanceUIDMap.get(url);
    },
  };
  return IWebApiDataSource.create(implementation);
}

export { createDicomUrlApi };
